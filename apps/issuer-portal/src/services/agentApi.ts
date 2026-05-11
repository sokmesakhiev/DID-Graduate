/**
 * Thin typed wrapper around the issuer-api REST endpoints.
 * All Cloud Agent calls are proxied through issuer-api so API keys
 * never appear in the browser's network traffic.
 */
import type {
  AgentConnection,
  AgentCredentialRecord,
  DiplomaIssuanceRequest,
} from "@university-diplomas/common";

/** Base URL for the issuer-api backend */
const API_BASE = import.meta.env.VITE_ISSUER_API_URL ?? "http://localhost:3002";
const AGENT_BASE = `${API_BASE}/api/agent`;

// ── DID Management ─────────────────────────────────────────────────────────────

export interface PrismDid {
  did: string;
  longFormDid: string;
  status: string;
}

/** List all DIDs managed by the issuer agent */
export async function listManagedDids(): Promise<PrismDid[]> {
  const res = await fetch(`${AGENT_BASE}/did-registrar/dids`);
  if (!res.ok) throw new Error(`listManagedDids: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.contents ?? []) as PrismDid[];
}

/** Create a new did:prism DID with authentication + assertionMethod keys */
export async function createPrismDid(): Promise<PrismDid> {
  const res = await fetch(`${AGENT_BASE}/did-registrar/dids`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      documentTemplate: {
        publicKeys: [
          { id: "auth-1", purpose: "authentication" },
          { id: "issue-1", purpose: "assertionMethod" },
        ],
        services: [],
      },
    }),
  });
  if (!res.ok) throw new Error(`createPrismDid: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Publish a DID to the ledger (Cardano preprod in preprod mode, in-memory in dev) */
export async function publishDid(didRef: string): Promise<{ scheduledOperation: { id: string } }> {
  const res = await fetch(`${AGENT_BASE}/did-registrar/dids/${encodeURIComponent(didRef)}/publications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`publishDid: ${res.status} ${res.statusText}`);
  return res.json();
}

// ── Schema Registry ───────────────────────────────────────────────────────────

export interface CredentialSchema {
  id: string;
  guid: string;
  longId: string;
  self: string;
  name: string;
  version: string;
  author: string;
}

export async function listSchemas(): Promise<CredentialSchema[]> {
  const res = await fetch(`${AGENT_BASE}/schema-registry/schemas`);
  if (!res.ok) throw new Error(`listSchemas: ${res.status}`);
  const data = await res.json();
  return (data.contents ?? []) as CredentialSchema[];
}

// ── Connections ────────────────────────────────────────────────────────────────

/** Create a DIDComm OOB invitation; returns the invitation URL for QR code display */
export async function createConnection(label: string): Promise<{
  connectionId: string;
  invitationUrl: string;
}> {
  const res = await fetch(`${AGENT_BASE}/connections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error(`createConnection: ${res.status} ${res.statusText}`);
  const data = await res.json() as { connectionId: string; invitation: { invitationUrl: string } };
  return {
    connectionId: data.connectionId,
    invitationUrl: data.invitation?.invitationUrl ?? "",
  };
}

export async function listConnections(): Promise<AgentConnection[]> {
  const res = await fetch(`${AGENT_BASE}/connections`);
  if (!res.ok) throw new Error(`listConnections: ${res.status}`);
  const data = await res.json();
  return (data.contents ?? []) as AgentConnection[];
}

/** Polls a connection until the student has accepted it (state transitions away from InvitationGenerated) */
export async function waitForConnection(
  connectionId: string,
  maxAttempts = 60,
  intervalMs = 3_000
): Promise<void> {
  const READY_STATES = new Set([
    "ConnectionResponseSent",
    "ConnectionResponseReceived",
  ]);
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${AGENT_BASE}/connections/${encodeURIComponent(connectionId)}`);
    if (!res.ok) throw new Error(`waitForConnection: ${res.status}`);
    const data = await res.json() as { state: string };
    if (READY_STATES.has(data.state)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for student to accept the connection (5 min). Please start over.");
}

// ── Credential Issuance ───────────────────────────────────────────────────────

/**
 * Creates a credential offer using the DIDComm with existing connection flow.
 * The student's Edge Agent will receive this offer via the mediator and must accept it.
 */
export async function createCredentialOffer(request: DiplomaIssuanceRequest & {
  issuingDid: string;
  schemaId: string;
}): Promise<AgentCredentialRecord> {
  const {
    studentName,
    studentId,
    degree,
    graduationDate,
    gpa,
    connectionId,
    issuingDid,
    schemaId,
  } = request;

  const claims: Record<string, unknown> = {
    studentName,
    studentId,
    degree,
    graduationDate,
    universityName: import.meta.env.VITE_UNIVERSITY_NAME ?? "Example University",
    universityDid: import.meta.env.VITE_UNIVERSITY_DID ?? issuingDid,
  };
  if (gpa !== undefined) claims.gpa = gpa;

  const res = await fetch(`${AGENT_BASE}/issue-credentials/credential-offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      claims,
      connectionId,
      issuingDID: issuingDid,
      schemaId,
      credentialFormat: "JWT",
      automaticIssuance: true,
      credentialStatus: { statusPurpose: "Revocation" },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createCredentialOffer: ${res.status} — ${text}`);
  }
  return res.json();
}

/** Polls until the credential record reaches a terminal state */
export async function pollCredentialRecord(
  recordId: string,
  maxAttempts = 40,
  intervalMs = 3_000
): Promise<AgentCredentialRecord> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${AGENT_BASE}/issue-credentials/records/${recordId}`);
    if (!res.ok) throw new Error(`pollCredentialRecord: ${res.status}`);
    const record = (await res.json()) as AgentCredentialRecord;
    if (record.protocolState === "CredentialSent") return record;
    if (record.protocolState === "ProblemReportPending") {
      throw new Error("Credential issuance failed (ProblemReportPending)");
    }
    await sleep(intervalMs);
  }
  throw new Error("Credential issuance timed out — student may not have accepted the offer yet");
}

export async function listCredentialRecords(): Promise<AgentCredentialRecord[]> {
  const res = await fetch(`${AGENT_BASE}/issue-credentials/records`);
  if (!res.ok) throw new Error(`listCredentialRecords: ${res.status}`);
  const data = await res.json();
  return (data.contents ?? []) as AgentCredentialRecord[];
}

// ── Cardano VC Hash ────────────────────────────────────────────────────────────

/** Sends the issued VC to issuer-api for hash submission to Cardano */
export async function writeVcHashToCardano(vc: unknown): Promise<{
  txHash: string;
  cardanoscanUrl: string;
  vcHash: string;
}> {
  const res = await fetch(`${API_BASE}/api/cardano/write-vc-hash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vc }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`writeVcHashToCardano: ${(err as { error: string }).error}`);
  }
  return res.json();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Students ──────────────────────────────────────────────────────────────────

export interface RegisteredStudent {
  id: string;
  email: string;
  name: string;
  studentNumber: string;
  connectionId?: string;
  walletDid?: string;
  createdAt: string;
  issuedCredentials?: IssuedCredential[];
}

export async function fetchStudents(): Promise<RegisteredStudent[]> {
  const res = await fetch(`${API_BASE}/api/students`);
  if (!res.ok) throw new Error(`fetchStudents: ${res.status}`);
  const data = await res.json();
  return (data.students ?? data) as RegisteredStudent[];
}

export async function fetchStudent(id: string): Promise<RegisteredStudent> {
  const res = await fetch(`${API_BASE}/api/students/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetchStudent: ${res.status}`);
  return res.json();
}

/** Queue a diploma for a student who hasn't connected yet.
 *  The issuer-api will auto-issue it as soon as the student's wallet connects. */
// ── Issued Credentials & Revocation ─────────────────────────────────────────

export interface IssuedCredential {
  credentialRecordId: string;
  degree: string;
  graduationDate: string;
  gpa?: number;
  issuedAt: string;
  revoked: boolean;
  revocationPendingAt?: string;
  revocationConfirmedAt?: string;
  revocationReason?: string;
  cardanoTxHash?: string;
  cardanoscanUrl?: string;
  cardanoRevocationTxHash?: string;
  cardanoRevocationUrl?: string;
  deliveryState?: string;
  deliveryCheckedAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export async function fetchIssuedCredentials(studentId: string): Promise<IssuedCredential[]> {
  const res = await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/credentials`);
  if (!res.ok) throw new Error(`fetchIssuedCredentials: ${res.status}`);
  return res.json();
}

export async function saveIssuedCredential(
  studentId: string,
  data: {
    credentialRecordId: string;
    degree: string;
    graduationDate: string;
    gpa?: number;
    issuingDid?: string;
    schemaId?: string;
    studentName?: string;
    studentIdField?: string;
  }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? `saveIssuedCredential: ${res.status}`);
  }
}

/** Update the Cardano on-chain anchor data for an already-stored credential. */
export async function updateCredentialCardano(
  studentId: string,
  recordId: string,
  cardanoTxHash: string,
  cardanoscanUrl: string
): Promise<void> {
  await fetch(
    `${API_BASE}/api/students/${encodeURIComponent(studentId)}/credentials/${encodeURIComponent(recordId)}/cardano`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardanoTxHash, cardanoscanUrl }),
    }
  );
}

export async function revokeCredential(
  studentId: string,
  recordId: string,
  reason?: string
): Promise<{ status: "pending" | "confirmed" }> {
  const res = await fetch(
    `${API_BASE}/api/students/${encodeURIComponent(studentId)}/credentials/${encodeURIComponent(recordId)}/revoke`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? `revokeCredential: ${res.status}`);
  }
  const data = await res.json() as { status?: string };
  return { status: (data.status ?? "pending") as "pending" | "confirmed" };
}

/** Query Cloud Agent for real delivery state. Returns updated credential fields. */
export async function checkCredentialDelivery(
  studentId: string,
  recordId: string
): Promise<{ state: string; failedAt?: string; failureReason?: string }> {
  const res = await fetch(
    `${API_BASE}/api/students/${encodeURIComponent(studentId)}/credentials/${encodeURIComponent(recordId)}/delivery-status`
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? `checkCredentialDelivery: ${res.status}`);
  }
  return res.json();
}

/** Manually mark a credential as failed/undeliverable. */
export async function markCredentialFailed(
  studentId: string,
  recordId: string,
  reason?: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/students/${encodeURIComponent(studentId)}/credentials/${encodeURIComponent(recordId)}/mark-failed`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? `markCredentialFailed: ${res.status}`);
  }
}

export async function queueDiploma(
  studentId: string,
  data: {
    studentName: string;
    studentIdField: string;
    degree: string;
    graduationDate: string;
    gpa?: number;
    issuingDid: string;
    schemaId: string;
  }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/diplomas/pending`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...data,
      universityName: import.meta.env.VITE_UNIVERSITY_NAME ?? "Example University",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to queue diploma");
}
