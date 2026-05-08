import { Router } from "express";
import jwt from "jsonwebtoken";
import {
  listStudents,
  updateConnection,
  clearConnection,
  findById,
  addPendingDiploma,
  getPendingDiplomas,
  removePendingDiploma,
  getWalletData,
  updateWalletData,
  updateWalletSeed,
  updateWalletDid,
  addIssuedCredential,
  getIssuedCredentials,
  markCredentialRevoked,
  markRevocationPending,
  confirmRevocation,
  type PendingDiploma,
} from "../services/studentStore.js";

export const studentsRouter = Router();

/** In-memory set of pending-diploma IDs currently being issued.
 *  Prevents concurrent background jobs from sending the same offer twice. */
const issuingInProgress = new Set<string>();
const JWT_SECRET =
  process.env.JWT_SECRET ?? "dev-jwt-secret-change-in-prod-please";
const ISSUER_AGENT_URL = process.env.ISSUER_AGENT_URL ?? "http://127.0.0.1:8000";
const ISSUER_API_KEY = process.env.ISSUER_API_KEY ?? "";
const UNIVERSITY_NAME = process.env.VITE_UNIVERSITY_NAME ?? "Example University";

function verifyToken(authHeader?: string): { sub: string } | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(authHeader.slice(7), JWT_SECRET) as { sub: string };
  } catch {
    return null;
  }
}

/** Poll the Cloud Agent until the DIDComm connection handshake is complete.
 *  acceptInvitation() on the student side only initiates the handshake —
 *  the actual exchange is async, so we must wait before issuing a credential. */
async function waitForConnectionReady(
  connectionId: string,
  maxAttempts = 20,
  intervalMs = 3_000
): Promise<boolean> {
  const READY_STATES = new Set(["ConnectionResponseSent", "ConnectionResponseReceived"]);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ISSUER_API_KEY) headers["apikey"] = ISSUER_API_KEY;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${ISSUER_AGENT_URL}/connections/${encodeURIComponent(connectionId)}`, { headers });
      if (res.ok) {
        const data = await res.json() as { state?: string };
        console.log(`[connection-poll] attempt ${i + 1}/${maxAttempts}: state=${data.state}`);
        if (data.state && READY_STATES.has(data.state)) return true;
      }
    } catch (e) {
      console.warn(`[connection-poll] attempt ${i + 1} error:`, e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Issue a pending diploma via the Cloud Agent. Returns the recordId on success, false on failure. */
async function issueCredentialNow(
  diploma: PendingDiploma,
  connectionId: string
): Promise<string | false> {
  try {
    const claims: Record<string, unknown> = {
      studentName: diploma.studentName,
      studentId: diploma.studentIdField,
      degree: diploma.degree,
      graduationDate: diploma.graduationDate,
      universityName: diploma.universityName || UNIVERSITY_NAME,
      universityDid: diploma.issuingDid,
    };
    if (diploma.gpa !== undefined) claims.gpa = diploma.gpa;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ISSUER_API_KEY) headers["apikey"] = ISSUER_API_KEY;

    const res = await fetch(`${ISSUER_AGENT_URL}/issue-credentials/credential-offers`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        claims,
        connectionId,
        issuingDID: diploma.issuingDid,
        schemaId: diploma.schemaId,
        credentialFormat: "JWT",
        automaticIssuance: true,
        credentialStatus: { statusPurpose: "Revocation" },
      }),
    });
    if (!res.ok) {
      console.error(`[auto-issue] Cloud Agent returned ${res.status} for pending diploma ${diploma.id}`);
      return false;
    }
    const data = await res.json() as { recordId?: string };
    if (data.recordId) {
      try {
        addIssuedCredential(diploma.studentId, {
          credentialRecordId: data.recordId,
          degree: diploma.degree,
          graduationDate: diploma.graduationDate,
          issuedAt: new Date().toISOString(),
          revoked: false,
        });
      } catch (e) {
        console.warn("[auto-issue] could not save issued credential record:", e);
      }
    }
    return data.recordId ?? "unknown";
  } catch (e) {
    console.error(`[auto-issue] failed for pending diploma ${diploma.id}:`, e);
    return false;
  }
}

// GET /api/students — issuer lists all registered students
// Also triggers a lazy backfill of walletDid for existing students who connected
// before the walletDid feature was added (reads theirDid from the Cloud Agent).
studentsRouter.get("/", (_req, res) => {
  const students = listStudents();
  res.json({ students });

  // Fire-and-forget: backfill walletDid for students who have connectionId but no walletDid.
  const needsBackfill = students.filter((s) => s.connectionId && !s.walletDid);
  if (needsBackfill.length === 0) return;

  void (async () => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (ISSUER_API_KEY) headers["apikey"] = ISSUER_API_KEY;
    for (const s of needsBackfill) {
      try {
        const r = await fetch(`${ISSUER_AGENT_URL}/connections/${encodeURIComponent(s.connectionId!)}`, { headers });
        if (!r.ok) continue;
        const data = await r.json() as { theirDid?: string };
        if (data.theirDid) {
          updateWalletDid(s.id, data.theirDid);
          console.log(`[backfill] saved walletDid for student ${s.id}`);
        }
      } catch (e) {
        console.warn(`[backfill] failed for student ${s.id}:`, e);
      }
    }
  })();
});

// GET /api/students/:id — fetch a single student record.
// If a valid student JWT matching this ID is present, responds for that student.
// If no auth header is provided (issuer portal context), also allows access —
// the list endpoint is already unauthenticated so this is not a regression.
studentsRouter.get("/:id", (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  // Allow: authenticated student accessing own record, OR unauthenticated issuer portal
  if (payload && payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const student = findById(req.params.id);
  if (!student) return res.status(404).json({ error: "Not found" });
  const { passwordHash: _pw, ...safe } = student;
  return res.json(safe);
});

// POST /api/students/:id/diplomas/deliver — called by student wallet at startup to
// trigger issuance of any pending diplomas (handles already-connected students).
studentsRouter.post("/:id/diplomas/deliver", async (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const student = findById(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });
  if (!student.connectionId) return res.json({ ok: true, pendingCount: 0, note: "no connection yet" });

  const pending = getPendingDiplomas(req.params.id);
  res.json({ ok: true, pendingCount: pending.length });

  if (pending.length === 0) return;

  void (async () => {
    try {
      await new Promise((r) => setTimeout(r, 3_000));
      const ready = await waitForConnectionReady(student.connectionId!);
      if (!ready) {
        console.warn(`[deliver] connection ${student.connectionId} not ready`);
        return;
      }
      for (const diploma of pending) {
        if (issuingInProgress.has(diploma.id)) {
          console.log(`[deliver] diploma ${diploma.id} already being issued — skipping`);
          continue;
        }
        // Re-check the store: another job may have already issued this diploma
        const stillPending = getPendingDiplomas(req.params.id).find((d) => d.id === diploma.id);
        if (!stillPending) continue;
        issuingInProgress.add(diploma.id);
        try {
          const result = await issueCredentialNow(diploma, student.connectionId!);
          if (result) {
            removePendingDiploma(diploma.id);
            console.log(`[deliver] issued diploma ${diploma.id} to student ${req.params.id}`);
          }
        } finally {
          issuingInProgress.delete(diploma.id);
        }
      }
    } catch (e) {
      console.error("[deliver] error:", e);
    }
  })();
});

// POST /api/students/:id/diplomas/pending — issuer queues a diploma for an unconnected student
studentsRouter.post("/:id/diplomas/pending", (req, res) => {
  const student = findById(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });

  const { studentName, studentIdField, degree, graduationDate, gpa, issuingDid, schemaId, universityName } = req.body ?? {};
  if (!studentName || !degree || !graduationDate || !issuingDid || !schemaId) {
    return res.status(400).json({ error: "studentName, degree, graduationDate, issuingDid and schemaId are required" });
  }

  const entry = addPendingDiploma({
    studentId: req.params.id,
    studentName,
    studentIdField: studentIdField ?? "",
    degree,
    graduationDate,
    gpa: gpa !== undefined ? Number(gpa) : undefined,
    issuingDid,
    schemaId,
    universityName: universityName ?? UNIVERSITY_NAME,
  });

  return res.status(201).json({ ok: true, pendingId: entry.id });
});

// DELETE /api/students/:id/connection — wallet calls this when it detects a
// fresh Pluto (cleared IndexedDB) so stored connection keys are gone.
// Clears the connectionId so the wallet can re-establish a fresh connection.
studentsRouter.delete("/:id/connection", (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    clearConnection(req.params.id);
    return res.json({ ok: true });
  } catch {
    return res.status(404).json({ error: "Student not found" });
  }
});

// GET /api/students/:id/connection/verify — check if the student's stored
// connectionId is still known to the Cloud Agent.  Clears it automatically
// if the agent returns 404 (e.g. after a container restart), so the wallet
// will auto-reconnect on next start.
studentsRouter.get("/:id/connection/verify", async (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const student = findById(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (!student.connectionId) {
    return res.json({ valid: false, reason: "no-connection" });
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (ISSUER_API_KEY) headers["apikey"] = ISSUER_API_KEY;

  try {
    const r = await fetch(
      `${ISSUER_AGENT_URL}/connections/${encodeURIComponent(student.connectionId)}`,
      { headers }
    );
    if (r.status === 404) {
      try { clearConnection(req.params.id); } catch { /* ignore */ }
      return res.json({ valid: false, reason: "stale" });
    }
    if (!r.ok) return res.json({ valid: false, reason: "agent-error" });
    const data = (await r.json()) as { state?: string; theirDid?: string };
    const READY_STATES = new Set(["ConnectionResponseSent", "ConnectionResponseReceived"]);
    // walletDid is the wallet's peer DID for this connection ("theirDid" from the
    // issuer agent's perspective).  The wallet needs this to verify it still has
    // the private keys for that peer DID in Pluto.
    return res.json({ valid: READY_STATES.has(data.state ?? ""), state: data.state, walletDid: data.theirDid });
  } catch {
    return res.json({ valid: false, reason: "network-error" });
  }
});

// PATCH /api/students/:id/connection — student stores connectionId after auto-connect
// Also auto-issues any pending diplomas queued for this student.
studentsRouter.patch("/:id/connection", async (req, res) => {
  const { connectionId } = req.body ?? {};
  if (!connectionId) {
    return res.status(400).json({ error: "connectionId required" });
  }

  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    updateConnection(req.params.id, connectionId);
  } catch {
    return res.status(404).json({ error: "Student not found" });
  }

  // Respond immediately so the student wallet finishes loading and its agent
  // reaches "ready" status before any credential offer arrives.
  // Diploma issuance runs in the background.
  const studentId = req.params.id;
  const pending = getPendingDiplomas(studentId);
  res.json({ ok: true, pendingCount: pending.length });

  if (pending.length === 0) return;

  // Fire-and-forget: wait for the DIDComm handshake to complete, then issue.
  // The student wallet agent is now free to run and receive incoming offers.
  void (async () => {
    try {
      // Short initial pause to let the DIDComm handshake finish on both sides
      await new Promise((r) => setTimeout(r, 5_000));
      const ready = await waitForConnectionReady(connectionId);
      if (!ready) {
        console.warn(`[auto-issue] connection ${connectionId} not ready after polling — diplomas will stay queued`);
        return;
      }

      // Persist the wallet's peer DID (theirDid) on the student record so the
      // issuer portal can display it and other services can reference it.
      try {
        const connHeaders: Record<string, string> = { Accept: "application/json" };
        if (ISSUER_API_KEY) connHeaders["apikey"] = ISSUER_API_KEY;
        const connRes = await fetch(`${ISSUER_AGENT_URL}/connections/${encodeURIComponent(connectionId)}`, { headers: connHeaders });
        if (connRes.ok) {
          const connData = await connRes.json() as { theirDid?: string };
          if (connData.theirDid) updateWalletDid(studentId, connData.theirDid);
        }
      } catch (e) {
        console.warn("[auto-issue] could not save walletDid:", e);
      }
      for (const diploma of pending) {
        if (issuingInProgress.has(diploma.id)) {
          console.log(`[auto-issue] diploma ${diploma.id} already being issued — skipping`);
          continue;
        }
        // Re-check the store: another job may have already issued this diploma
        const stillPending = getPendingDiplomas(studentId).find((d) => d.id === diploma.id);
        if (!stillPending) continue;
        issuingInProgress.add(diploma.id);
        try {
          const result = await issueCredentialNow(diploma, connectionId);
          if (result) {
            removePendingDiploma(diploma.id);
            console.log(`[auto-issue] issued pending diploma ${diploma.id} to student ${studentId}`);
          } else {
            console.error(`[auto-issue] failed for diploma ${diploma.id}`);
          }
        } finally {
          issuingInProgress.delete(diploma.id);
        }
      }
    } catch (e) {
      console.error("[auto-issue] background job error:", e);
    }
  })();
});

// GET /api/students/:id/wallet-backup
// Returns the stored HD seed + Pluto backup so the wallet can restore itself
// on any device.  Only the authenticated student can read their own backup.
studentsRouter.get("/:id/wallet-backup", (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const data = getWalletData(req.params.id);
  return res.json(data);
});

// PUT /api/students/:id/wallet-backup
// Saves the HD seed + full Pluto backup.  Called by the wallet after each
// new credential is received so the server always has an up-to-date copy.
studentsRouter.put("/:id/wallet-backup", (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { seed, backup } = (req.body ?? {}) as { seed?: number[]; backup?: unknown };
  if (!seed || !backup) {
    return res.status(400).json({ error: "seed and backup required" });
  }
  try {
    updateWalletData(req.params.id, seed, backup);
    return res.json({ ok: true });
  } catch {
    return res.status(404).json({ error: "Student not found" });
  }
});

// PATCH /api/students/:id/wallet-seed
// Saves only the seed (called on first session before any backup exists).
studentsRouter.patch("/:id/wallet-seed", (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { seed } = (req.body ?? {}) as { seed?: number[] };
  if (!seed) return res.status(400).json({ error: "seed required" });
  try {
    updateWalletSeed(req.params.id, seed);
    return res.json({ ok: true });
  } catch {
    return res.status(404).json({ error: "Student not found" });
  }
});

// ── Issued Credentials & Revocation ──────────────────────────────────────────

// GET /api/students/:id/credentials
// Returns all issued credentials for a student (issuer-portal use, no student auth required).
studentsRouter.get("/:id/credentials", (req, res) => {
  const creds = getIssuedCredentials(req.params.id);
  return res.json(creds);
});

// POST /api/students/:id/credentials
// Saves a credential record after direct issuance from the issuer portal.
studentsRouter.post("/:id/credentials", (req, res) => {
  const { credentialRecordId, degree, graduationDate, gpa } = (req.body ?? {}) as {
    credentialRecordId?: string;
    degree?: string;
    graduationDate?: string;
    gpa?: number;
  };
  if (!credentialRecordId || !degree || !graduationDate) {
    return res.status(400).json({ error: "credentialRecordId, degree, and graduationDate are required" });
  }
  try {
    addIssuedCredential(req.params.id, {
      credentialRecordId,
      degree,
      graduationDate,
      ...(gpa !== undefined ? { gpa } : {}),
      issuedAt: new Date().toISOString(),
      revoked: false,
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(404).json({ error: e instanceof Error ? e.message : "Failed to save credential" });
  }
});

// POST /api/students/:id/credentials/:recordId/revoke
// Initiates revocation: sets the status list bit on the agent then marks pending locally.
// The issuer portal polls for revoked:true, which is only set after the student wallet confirms.
studentsRouter.post("/:id/credentials/:recordId/revoke", async (req, res) => {
  const { id, recordId } = req.params;
  const { reason } = (req.body ?? {}) as { reason?: string };

  // Idempotency: if already fully revoked, skip the agent call
  const existing = getIssuedCredentials(id).find((c) => c.credentialRecordId === recordId);
  if (existing?.revoked) {
    return res.json({ ok: true, status: "confirmed", alreadyRevoked: true });
  }
  // If pending but not yet confirmed, still wait
  if (existing?.revocationPendingAt) {
    return res.json({ ok: true, status: "pending" });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ISSUER_API_KEY) headers["apikey"] = ISSUER_API_KEY;

  let agentRes: Response;
  try {
    agentRes = await fetch(
      `${ISSUER_AGENT_URL}/credential-status/revoke-credential/${recordId}`,
      { method: "PATCH", headers }
    );
  } catch (e) {
    console.error("[revoke] network error calling agent:", e);
    return res.status(502).json({ error: "Failed to reach Cloud Agent" });
  }

  if (!agentRes.ok) {
    const text = await agentRes.text().catch(() => "");
    console.error(`[revoke] agent returned ${agentRes.status}: ${text}`);
    return res.status(agentRes.status).json({ error: `Agent error: ${agentRes.status}`, detail: text });
  }

  try {
    markRevocationPending(id, recordId, reason);
  } catch (e) {
    console.warn("[revoke] local markRevocationPending failed:", e);
  }

  return res.json({ ok: true, status: "pending" });
});

// POST /api/students/:id/credentials/:recordId/revocation-confirmed
// Called by the student wallet once it has stored the revocation locally.
studentsRouter.post("/:id/credentials/:recordId/revocation-confirmed", (req, res) => {
  const payload = verifyToken(req.headers.authorization);
  if (!payload || payload.sub !== req.params.id) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    confirmRevocation(req.params.id, req.params.recordId);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
