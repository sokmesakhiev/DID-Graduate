import { config } from "dotenv";
import { resolve } from "path";
// Load .env from monorepo root (three levels up from apps/issuer-api/src/)
config({ path: resolve(__dirname, "../../../.env") });
import express from "express";
import cors from "cors";
import { cardanoRouter } from "./routes/cardano.js";
import { agentProxyRouter } from "./routes/agentProxy.js";
import { authRouter } from "./routes/auth.js";
import { studentsRouter } from "./routes/students.js";
import { listStudents, getIssuedCredentials, updateDeliveryState, markCredentialFailed, confirmRevocation } from "./services/studentStore.js";

const app = express();
const PORT = process.env.PORT ?? 3002;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(
  cors({
    // Allow any localhost origin in dev (Vite may use varying ports on restarts)
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("http://localhost:")) {
        callback(null, true);
      } else {
        callback(new Error("CORS not allowed from " + origin));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "2mb" }));

// ── DIDComm proxy ──────────────────────────────────────────────────────────────
// The student wallet (browser) sends DIDComm messages to the issuer.
// Browser → localhost:8001 is blocked by CORS; we proxy via this server which
// has CORS headers, forwarding raw bytes to the issuer agent's DIDComm port.
const ISSUER_DIDCOMM_URL = process.env.ISSUER_DIDCOMM_URL ?? "http://127.0.0.1:8001";
app.post("/didcomm", express.raw({ type: "*/*", limit: "4mb" }), async (req, res) => {
  try {
    const upstream = await fetch(ISSUER_DIDCOMM_URL, {
      method: "POST",
      headers: {
        "Content-Type": req.headers["content-type"] ?? "application/didcomm-encrypted+json",
      },
      body: req.body as Buffer,
    });
    const body = await upstream.arrayBuffer();
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.send(Buffer.from(body));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[didcomm-proxy] error:", msg);
    res.status(502).json({ error: "DIDComm upstream unreachable" });
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use("/api/cardano", cardanoRouter);
app.use("/api/agent", agentProxyRouter);
app.use("/api/auth", authRouter);
app.use("/api/students", studentsRouter);

// ── Health ─────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    blockfrostConfigured: Boolean(process.env.BLOCKFROST_PROJECT_ID?.startsWith("preprod")),
    walletConfigured: Boolean(process.env.CARDANO_WALLET_MNEMONIC),
  });
});

app.listen(PORT, () => {
  console.log(`issuer-api running on http://localhost:${PORT}`);
  if (!process.env.BLOCKFROST_PROJECT_ID || process.env.BLOCKFROST_PROJECT_ID === "preprodXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX") {
    console.warn("⚠  BLOCKFROST_PROJECT_ID not set — Cardano hash writing will fail");
  }
  if (!process.env.CARDANO_WALLET_MNEMONIC) {
    console.warn("⚠  CARDANO_WALLET_MNEMONIC not set — Cardano hash writing will fail");
  }

  // ── Delivery sweep ──────────────────────────────────────────────────────────
  // Every 30 minutes: check Cloud Agent state for every credential that hasn't
  // been fully resolved (not revoked, not already failed, delivery not confirmed).
  // Auto-marks as failed if the offer has been stuck for 48 h or a problem report
  // was received.
  const ISSUER_AGENT_URL = process.env.ISSUER_AGENT_URL ?? "http://127.0.0.1:8000";
  const ISSUER_API_KEY   = process.env.ISSUER_API_KEY ?? "";
  const SWEEP_INTERVAL_MS = 30 * 1000; // 30 s (TODO: change back to 30 * 60 * 1000 for prod)
  const STALE_THRESHOLD_H = 48;
  const REVOCATION_ACK_TIMEOUT_H = 7 * 24; // 7 days

  async function sweepDeliveryStates() {
    const students = listStudents();
    let checked = 0;
    let flagged = 0;
    let autoConfirmed = 0;

    for (const student of students) {
      const creds = getIssuedCredentials(student.id);
      for (const cred of creds) {
        // ── Stuck revocation: auto-confirm after threshold ──────────────────
        // The status list bit is already set — revocation is legally effective.
        // If the student wallet never came online to ack, confirm it server-side
        // so both portals show "Revoked" instead of "Revoking..." forever.
        if (cred.revocationPendingAt && !cred.revoked && !cred.revocationConfirmedAt) {
          const hoursElapsed = (Date.now() - new Date(cred.revocationPendingAt).getTime()) / 3_600_000;
          if (hoursElapsed >= REVOCATION_ACK_TIMEOUT_H) {
            try {
              confirmRevocation(student.id, cred.credentialRecordId);
              autoConfirmed++;
              console.log(`[delivery-sweep] Auto-confirmed revocation for ${cred.credentialRecordId} (${Math.floor(hoursElapsed)}h pending)`);
            } catch { /* non-fatal */ }
          }
          continue; // don't also run delivery check on a revoking cred
        }

        // Skip already-terminal states for delivery check
        if (cred.revoked || cred.failedAt) continue;
        // Skip if recently checked (< 25 min ago) — avoid hammering the agent
        if (cred.deliveryCheckedAt) {
          const age = Date.now() - new Date(cred.deliveryCheckedAt).getTime();
          if (age < 25 * 1000) continue; // TODO: change back to 25 * 60 * 1000 for prod
        }

        try {
          const headers: Record<string, string> = {};
          if (ISSUER_API_KEY) headers["apikey"] = ISSUER_API_KEY;

          const res = await fetch(
            `${ISSUER_AGENT_URL}/issue-credentials/records/${cred.credentialRecordId}`,
            { headers, signal: AbortSignal.timeout(8000) }
          );
          if (!res.ok) continue; // agent may not know about very old records

          const record = await res.json() as { protocolState?: string };
          const state = record.protocolState ?? "Unknown";
          updateDeliveryState(student.id, cred.credentialRecordId, state);
          checked++;

          // Auto-flag failure conditions
          if (state === "ProblemReportReceived") {
            markCredentialFailed(student.id, cred.credentialRecordId, "Holder sent a problem report — credential was rejected");
            flagged++;
          } else if (state === "OfferSent" || state === "OfferPending") {
            const hoursElapsed = (Date.now() - new Date(cred.issuedAt).getTime()) / 3_600_000;
            if (hoursElapsed >= STALE_THRESHOLD_H) {
              markCredentialFailed(
                student.id,
                cred.credentialRecordId,
                `Offer stuck in ${state} for ${Math.floor(hoursElapsed)}h — student wallet never responded`
              );
              flagged++;
            }
          }
        } catch {
          // Non-fatal — network blip or agent restart, will retry next sweep
        }
      }
    }

    if (checked > 0 || flagged > 0 || autoConfirmed > 0) {
      console.log(`[delivery-sweep] checked=${checked} flagged=${flagged} autoConfirmed=${autoConfirmed}`);
    }
  }

  // Run once 5 s after startup (TODO: change back to 60_000 for prod), then every 30 s
  setTimeout(() => {
    void sweepDeliveryStates();
    setInterval(() => void sweepDeliveryStates(), SWEEP_INTERVAL_MS);
  }, 5_000);
});
