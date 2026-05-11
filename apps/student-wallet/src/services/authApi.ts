const API_BASE = import.meta.env.VITE_ISSUER_API_URL ?? "http://localhost:3002";

export interface StudentUser {
  id: string;
  email: string;
  name: string;
  studentNumber: string;
  connectionId?: string;
}

export async function register(
  email: string,
  password: string,
  name: string,
  studentNumber: string
): Promise<{ token: string; student: StudentUser }> {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name, studentNumber }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Registration failed");
  return data as { token: string; student: StudentUser };
}

export async function login(
  email: string,
  password: string
): Promise<{ token: string; student: StudentUser }> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Login failed");
  return data as { token: string; student: StudentUser };
}

export interface IssuedCredentialRecord {
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
  issuingDid?: string;
  walletConfirmedAt?: string;
}

/** Fetch the list of issued credentials for this student (includes revocation status). */
export async function fetchStudentCredentials(
  studentId: string,
  token: string
): Promise<IssuedCredentialRecord[]> {
  const res = await fetch(`${API_BASE}/api/students/${studentId}/credentials`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return res.json() as Promise<IssuedCredentialRecord[]>;
}

/** Confirm to the issuer that this student's wallet has processed the revocation. */
export async function confirmRevocation(
  studentId: string,
  recordId: string,
  token: string
): Promise<void> {
  await fetch(`${API_BASE}/api/students/${studentId}/credentials/${recordId}/revocation-confirmed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  }).catch(() => { /* non-fatal — issuer can retry */ });
}

/** Tell the issuer-api which DIDComm connection belongs to this student. */
export async function saveConnectionId(
  studentId: string,
  connectionId: string,
  token: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/students/${studentId}/connection`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ connectionId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `saveConnectionId: ${res.status}`);
  }
}

/** Create an OOB connection on the issuer agent (proxied through issuer-api). */
export async function createIssuerConnection(
  label: string
): Promise<{ connectionId: string; invitationUrl: string }> {
  const res = await fetch(`${API_BASE}/api/agent/connections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to create connection");
  return {
    connectionId: data.connectionId as string,
    invitationUrl: (data.invitation?.invitationUrl ?? data.invitationUrl) as string,
  };
}

/** Clear the student's connectionId on the server when they log out.
 *  Best-effort: errors are intentionally swallowed. */
export async function clearConnectionId(
  studentId: string,
  token: string
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/connection`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Non-fatal
  }
}

/** Verify that the student's stored connectionId is still valid in the Cloud Agent.
 *  Returns { valid: false, reason: "stale" } after a container restart — in that
 *  case the server also clears the stored connectionId automatically. */
export async function verifyConnection(
  studentId: string,
  token: string
): Promise<{ valid: boolean; reason?: string; state?: string; walletDid?: string }> {
  try {
    const res = await fetch(
      `${API_BASE}/api/students/${encodeURIComponent(studentId)}/connection/verify`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return { valid: false, reason: "error" };
    return res.json() as Promise<{ valid: boolean; reason?: string; state?: string }>;
  } catch {
    return { valid: false, reason: "network-error" };
  }
}

/** Trigger delivery of any pending diplomas queued by the issuer for this student.
 *  Call this after the agent is running so the wallet can receive the offers. */
export async function deliverPendingDiplomas(
  studentId: string,
  token: string
): Promise<void> {
  await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/diplomas/deliver`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  // Fire-and-forget: server handles issuance in background — no need to await response body
}

/** Notify the issuer-api that the wallet has successfully stored a credential.
 *  The server uses this as the trigger to write the Cardano issuance anchor.
 *  thid = DIDComm thread ID = Cloud Agent recordId */
export async function walletConfirmedReceipt(
  studentId: string,
  token: string,
  thid: string
): Promise<void> {
  try {
    await fetch(
      `${API_BASE}/api/students/${encodeURIComponent(studentId)}/credentials/${encodeURIComponent(thid)}/wallet-confirmed`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
  } catch { /* non-fatal — anchoring is best-effort */ }
}

// ── Wallet backup ─────────────────────────────────────────────────────────────

/** Fetch the server-side wallet backup (seed + Pluto snapshot) for this student.
 *  Returns nulls when the student has never saved a backup (first ever session). */
export async function fetchWalletBackup(
  studentId: string,
  token: string
): Promise<{ seed: number[] | null; backup: unknown | null }> {
  try {
    const res = await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/wallet-backup`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { seed: null, backup: null };
    return res.json() as Promise<{ seed: number[] | null; backup: unknown | null }>;
  } catch {
    return { seed: null, backup: null };
  }
}

/** Save (or update) the server-side wallet backup after a new credential arrives. */
export async function saveWalletBackup(
  studentId: string,
  token: string,
  seed: number[],
  backup: unknown
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/wallet-backup`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ seed, backup }),
    });
  } catch { /* non-fatal — wallet still works locally */ }
}

/** Persist the wallet seed on first session (before any credentials exist). */
export async function saveWalletSeed(
  studentId: string,
  token: string,
  seed: number[]
): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/students/${encodeURIComponent(studentId)}/wallet-seed`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ seed }),
    });
  } catch { /* non-fatal */ }
}
