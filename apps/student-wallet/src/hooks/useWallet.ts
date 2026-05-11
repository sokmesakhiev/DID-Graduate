import { useState, useEffect, useCallback, useRef } from "react";
import SDK from "@hyperledger/identus-edge-agent-sdk";
import {
  startAgent,
  stopAgent,
  getAllCredentials,
  registerMessageListener,
  acceptInvitation,
  isFreshSession,
  hasConnectionKeys,
  exportBackup,
  getSessionSeed,
  deleteWalletDatabase,
  getPeerDids,
} from "../services/edgeAgent.js";
import {
  createIssuerConnection,
  saveConnectionId,
  deliverPendingDiplomas,
  walletConfirmedReceipt,
  verifyConnection,
  fetchWalletBackup,
  saveWalletBackup,
  saveWalletSeed,
  fetchStudentCredentials,
} from "../services/authApi.js";
import type { StudentUser } from "../services/authApi.js";

export type WalletStatus = "idle" | "starting" | "connecting" | "ready" | "error";

export interface UseWalletResult {
  status: WalletStatus;
  agent: SDK.Agent | null;
  credentials: SDK.Domain.Credential[];
  pendingProofRequest: SDK.Domain.Message | null;
  error: string | null;
  connectionError: string | null;
  isConnecting: boolean;
  walletDid: string | null;
  start: () => void;
  stop: () => void;
  refreshCredentials: () => Promise<void>;
  clearProofRequest: () => void;
  retryConnection: () => Promise<void>;
}

export function useWallet(
  currentUser: StudentUser | null,
  token: string | null
): UseWalletResult {
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [agent, setAgent] = useState<SDK.Agent | null>(null);
  const [credentials, setCredentials] = useState<SDK.Domain.Credential[]>([]);
  const [pendingProofRequest, setPendingProofRequest] = useState<SDK.Domain.Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [walletDid, setWalletDid] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // Ref always holds the latest userId so the unmount cleanup can pass it
  // to stopAgent — preventing it from killing a different user's agent.
  const userIdRef = useRef<string | undefined>(currentUser?.id);

  const refreshCredentials = useCallback(async () => {
    const creds = await getAllCredentials();
    // getAllCredentials() returns [] when the agent isn't running (_pluto is null).
    // Don't overwrite a non-empty credential list with an empty one in that case —
    // this prevents diplomas from disappearing if a transient agent stop occurs.
    setCredentials((prev) => (creds.length === 0 && prev.length > 0 ? prev : creds));
  }, []);

  const start = useCallback(async () => {
    if (!currentUser) return;
    setStatus("starting");
    setError(null);
    try {
      // Fetch seed + Pluto backup from the server before starting the agent.
      // On a fresh device (incognito, new browser, tab after close-cleanup)
      // this restores the full wallet so diplomas are immediately visible.
      let serverSeed: number[] | null = null;
      let serverBackup: unknown | null = null;
      if (token) {
        const { seed, backup } = await fetchWalletBackup(currentUser.id, token);
        serverSeed = seed;
        serverBackup = backup;
      }

      const a = await startAgent(currentUser.id, serverSeed, serverBackup);
      setAgent(a);

      // If this is the first ever session (no server seed yet), save the generated seed now.
      if (!serverSeed && token) {
        const generated = getSessionSeed();
        if (generated) void saveWalletSeed(currentUser.id, token, generated);
      }

      await refreshCredentials();

      // Startup confirmation: fire walletConfirmedReceipt for any credential already
      // in Pluto that the server hasn't anchored yet. Handles credentials received
      // before this code was deployed, or while the wallet was offline.
      if (token) {
        try {
          const serverRecords = await fetchStudentCredentials(currentUser.id, token);
          const plutoCreds = await getAllCredentials();
          for (const record of serverRecords) {
            if (!record.issuingDid || record.cardanoTxHash || record.revoked) continue;
            const hasIt = plutoCreds.some((c) => {
              try {
                const cr = c as unknown as Record<string, unknown>;
                let raw: unknown =
                  cr["claims"] ??
                  cr["credentialSubject"] ??
                  (cr["vc"] as Record<string, unknown> | undefined)?.["credentialSubject"];
                if (Array.isArray(raw)) {
                  const first = raw[0] as Record<string, unknown>;
                  raw = (first && "name" in first)
                    ? Object.fromEntries((raw as Array<{ name: string; value: unknown }>).map((x) => [x.name, x.value]))
                    : first;
                }
                const obj = raw as Record<string, unknown>;
                return obj["degree"] === record.degree && obj["graduationDate"] === record.graduationDate;
              } catch { return false; }
            });
            if (hasIt) void walletConfirmedReceipt(currentUser.id, token, record.credentialRecordId);
          }
        } catch { /* non-fatal */ }
      }

      // Migration / repair: save an up-to-date backup when:
      //   (a) no backup has ever been saved yet, OR
      //   (b) a backup exists but has no credentials (was saved with the
      //       getPeerDids() bug that corrupted _pluto before the backup call).
      // This ensures all devices can restore to the latest state.
      const backupIsEmpty =
        !serverBackup ||
        (Array.isArray((serverBackup as { credentials?: unknown[] }).credentials) &&
          (serverBackup as { credentials: unknown[] }).credentials.length === 0);
      if (token && backupIsEmpty) {
        const existing = await getAllCredentials();
        if (existing.length > 0) {
          const seed = getSessionSeed();
          const backup = await exportBackup();
          if (seed && backup) void saveWalletBackup(currentUser.id, token, seed, backup);
        }
      }

      const unsubscribe = registerMessageListener(
        async (_newCred, thid) => {
          await refreshCredentials();
          // Notify the issuer-api that the wallet has the credential.
          // This is the trigger for the Cardano issuance anchor.
          if (currentUser && token && thid) {
            void walletConfirmedReceipt(currentUser.id, token, thid);
          }
          // Save an up-to-date backup after each new credential so any device
          // can restore to the latest state on next login.
          if (token) {
            const seed = getSessionSeed();
            const backup = await exportBackup();
            if (seed && backup) void saveWalletBackup(currentUser.id, token, seed, backup);
          }
        },
        (request) => {
          setPendingProofRequest(request);
        }
      );
      unsubscribeRef.current = unsubscribe;

      // ── Stale-connection detection ────────────────────────────────────────
      // Case 1: Fresh Pluto (IndexedDB was cleared) — all DIDComm connection
      //   private keys are gone.  The stored connectionId is definitely stale.
      // Case 2: The Cloud Agent no longer knows about the stored connectionId
      //   (e.g. agent was restarted with in-memory storage).
      // In both cases we clear the connectionId and let the auto-connect block
      // below re-establish a fresh connection.
      if (currentUser?.connectionId && token) {
        let shouldClear = false;

        if (isFreshSession()) {
          console.warn("[auto-connect] Fresh Pluto detected — stored connectionId is stale (keys gone)");
          shouldClear = true;
        } else {
          try {
            const check = await verifyConnection(currentUser.id, token);
            if (!check.valid) {
              console.warn("[auto-connect] Stored connection invalid on agent side, reason:", check.reason);
              shouldClear = true;            } else if (check.walletDid) {
              // Capture the wallet DID from the Cloud Agent's connection record —
              // this is the most reliable source (already resolved server-side).
              setWalletDid(check.walletDid);
              // Connection exists in the Cloud Agent but verify the wallet still
              // has private keys for the connection's peer DID.
              // Catches "partial Pluto reset": mediator record survives via a
              // QR-flow connection (isFreshSession = false) but the auto-connect
              // peer DID keys are gone → offers permanently stuck at OfferSent.
              const hasKeys = await hasConnectionKeys(check.walletDid);
              if (!hasKeys) {
                console.warn("[auto-connect] Wallet missing private keys for connection peer DID — clearing stale connectionId");
                shouldClear = true;
              }            }
          } catch { /* non-fatal — keep existing connectionId */ }
        }

        if (shouldClear) {
          try {
            // Tell the server to clear the stale connectionId
            await fetch(`${import.meta.env.VITE_ISSUER_API_URL ?? "http://localhost:3002"}/api/students/${currentUser.id}/connection`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch { /* non-fatal */ }
          currentUser.connectionId = undefined;
          try {
            const saved = sessionStorage.getItem("wallet_user");
            if (saved) {
              const parsed = JSON.parse(saved) as Record<string, unknown>;
              delete parsed.connectionId;
              sessionStorage.setItem("wallet_user", JSON.stringify(parsed));
            }
          } catch { /* storage unavailable */ }
        }
      }

      // Auto-connect: if the student has no connectionId yet, establish one now.
      // Track whether we just connected so we don't double-issue below —
      // the PATCH handler already fires background issuance for new connections.
      let didAutoConnect = false;
      if (currentUser && token && !currentUser.connectionId) {
        setStatus("connecting");
        try {
          const { connectionId, invitationUrl } = await createIssuerConnection(
            `Wallet – ${currentUser.name}`
          );
          await acceptInvitation(invitationUrl);
          await saveConnectionId(currentUser.id, connectionId, token);
          // Update in-memory user so we don't reconnect on next mount
          currentUser.connectionId = connectionId;
          // Persist to sessionStorage (tab-scoped, cleared on tab close)
          try {
            const saved = sessionStorage.getItem("wallet_user");
            if (saved) {
              sessionStorage.setItem("wallet_user", JSON.stringify({ ...JSON.parse(saved), connectionId }));
            }
          } catch { /* storage unavailable */ }
          setConnectionError(null);
          didAutoConnect = true;
        } catch (connErr) {
          const msg = connErr instanceof Error ? connErr.message : String(connErr);
          console.warn("[auto-connect] failed:", msg);
          setConnectionError(msg);
        }
      }

      setStatus("ready");

      // Second credential refresh after everything has settled — guards against
      // RxDB async indexing lag right after pluto.restore() completes.
      void refreshCredentials();

      // Populate the wallet DID — pick the first peer DID that isn't the
      // mediator's own DID (which is an env-var constant, not a wallet-owned DID).
      // This is a fallback for new connections where verifyConnection isn't called.
      void getPeerDids().then((dids) => {
        if (dids.length > 0) setWalletDid((prev) => prev ?? dids[0].toString());
      });

      // Call /deliver whenever the student has a connectionId:
      // - Returning sessions: deliver any queued diplomas.
      // - After stale-connection reset + auto-connect: re-issue queued diplomas
      //   to the NEW connectionId (old offers encrypted for the old peer DID
      //   are undeliverable; the queue is the source of truth).
      // Skip only when this is a truly brand-new registration with no prior
      // connection — the PATCH handler fires issuance for that case.
      if (currentUser?.connectionId && token) {
        void deliverPendingDiplomas(currentUser.id, token).catch(
          (e) => console.warn("[deliver] non-fatal:", e)
        );
      }
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshCredentials, currentUser, token]);

  // Keep the ref in sync with the latest currentUser
  useEffect(() => {
    userIdRef.current = currentUser?.id;
  }, [currentUser]);

  // Auto-start when a user is logged in
  useEffect(() => {
    if (currentUser && status === "idle") {
      start();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // Periodic credential refresh — guards against missed MESSAGE events
  // (e.g., browser tab throttled, mediator hiccup, SDK event loop stopped).
  // Polls Pluto every 20 s so the UI always reflects the latest stored credentials.
  useEffect(() => {
    if (status !== "ready") return;
    const id = setInterval(() => { void refreshCredentials(); }, 20_000);
    return () => clearInterval(id);
  }, [status, refreshCredentials]);

  const stop = useCallback(async () => {
    unsubscribeRef.current?.();
    const uid = userIdRef.current;
    if (uid) {
      // Delete the IndexedDB so no wallet data remains on the device after logout.
      await deleteWalletDatabase(uid);
    } else {
      await stopAgent(undefined);
    }
    setAgent(null);
    setStatus("idle");
  }, []);

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      // Pass userId so stopAgent is a no-op if a different user's agent
      // has already been started (prevents killing the new user's agent).
      void stopAgent(userIdRef.current);
    };
  }, []);

  // On a public/shared device: delete the wallet IndexedDB when the tab closes
  // so no credentials remain on the device after the student walks away.
  // Only active when the student checked "This is a shared or public device" at login.
  // Normal (private device) sessions are unaffected — data persists for fast reload.
  useEffect(() => {
    const handlePageHide = (e: PageTransitionEvent) => {
      // persisted=true → page going into bfcache (back/forward), not truly closing
      if (e.persisted) return;
      if (sessionStorage.getItem("wallet_public_device") !== "true") return;
      const uid = userIdRef.current;
      if (uid) void deleteWalletDatabase(uid);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  const retryConnection = useCallback(async () => {
    if (!currentUser || !token || isConnecting) return;
    setConnectionError(null);
    setIsConnecting(true);
    try {
      const { connectionId, invitationUrl } = await createIssuerConnection(
        `Wallet – ${currentUser.name}`
      );
      await acceptInvitation(invitationUrl);
      await saveConnectionId(currentUser.id, connectionId, token);
      currentUser.connectionId = connectionId;
      try {
        const saved = sessionStorage.getItem("wallet_user");
        if (saved) {
          sessionStorage.setItem("wallet_user", JSON.stringify({ ...JSON.parse(saved), connectionId }));
        }
      } catch { /* storage unavailable */ }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[retry-connect] failed:", msg);
      setConnectionError(msg);
    } finally {
      setIsConnecting(false);
    }
  }, [currentUser, token, isConnecting]);

  return {
    status,
    agent,
    credentials,
    pendingProofRequest,
    error,
    connectionError,
    isConnecting,
    walletDid,
    start,
    stop,
    refreshCredentials,
    clearProofRequest: () => setPendingProofRequest(null),
    retryConnection,
  };
}

