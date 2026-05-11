/**
 * Edge Agent service — wraps @hyperledger/identus-edge-agent-sdk v6.6.0.
 *
 * Architecture:
 *   Apollo   — cryptographic primitives (key generation, signing) + KeyRestoration
 *   Castor   — DID creation & resolution (did:prism, did:peer)
 *   Pluto    — persistent storage (IndexedDB via RxDB + Dexie)
 *   Mercury  — DIDComm V2 messaging
 *   Agent    — top-level orchestrator; runs message loop with mediator
 */

import SDK from "@hyperledger/identus-edge-agent-sdk";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { wrappedKeyEncryptionCryptoJsStorage } from "rxdb/plugins/encryption-crypto-js";

const MEDIATOR_PEER_DID = import.meta.env.VITE_MEDIATOR_PEER_DID ?? "";

// Lazily-initialised agent singleton (scoped to the currently logged-in user)
let _agent: SDK.Agent | null = null;
let _pluto: SDK.Pluto | null = null;
let _apollo: SDK.Apollo | null = null;
let _currentUserId: string | null = null;

// The seed used for the current session — held so callers can persist it
// server-side on first use without re-deriving it.
let _sessionSeed: Uint8Array | null = null;

// In-flight promises used to serialize stop → start and avoid race conditions.
// stopAgent (fire-and-forget from cleanup) sets _stopPromise so that any
// concurrent startAgent call waits for the old agent to fully stop before
// opening a new Pluto database (prevents "Start Pluto first." SDK errors).
let _stopPromise: Promise<void> | null = null;
let _startPromise: Promise<SDK.Agent> | null = null;

/**
 * Returns the Pluto storage handle for the given user.
 * Each user gets their own IndexedDB database so credentials are fully isolated.
 */
async function getPluto(userId: string): Promise<{ pluto: SDK.Pluto; apollo: SDK.Apollo }> {
  if (_pluto && _apollo && _currentUserId === userId) return { pluto: _pluto, apollo: _apollo };

  _apollo = new SDK.Apollo();
  // DB name is scoped to the user — each student has their own isolated credential store.
  const store = new SDK.Store({
    name: `diploma-wallet-${userId}`,
    storage: wrappedKeyEncryptionCryptoJsStorage({ storage: getRxStorageDexie() }),
    password: `diploma-wallet-pass-${userId}`,
  });
  _pluto = new SDK.Pluto(store, _apollo);
  await _pluto.start();
  _currentUserId = userId;

  return { pluto: _pluto, apollo: _apollo };
}

/**
 * Use the server-provided seed if available; otherwise generate a new one.
 * The seed is kept in memory (_sessionSeed) so useWallet can save it server-side
 * on first use.  localStorage is intentionally NOT used here — the server is the
 * single source of truth so the wallet is device-independent.
 */
function getOrCreateSeed(apollo: SDK.Apollo, serverSeed: number[] | null) {
  if (serverSeed && serverSeed.length > 0) {
    _sessionSeed = new Uint8Array(serverSeed);
    return { value: _sessionSeed };
  }
  const { seed } = apollo.createRandomSeed();
  _sessionSeed = seed.value;
  return seed;
}

// Set to true when the last startAgent call found an empty Pluto (fresh IndexedDB).
// A fresh Pluto means all previously stored DIDComm connection keys are gone —
// any connectionId stored on the server is therefore stale and must be cleared.
let _freshSession = false;

/** True if the most recent startAgent() found a fresh (empty) Pluto database. */
export function isFreshSession(): boolean {
  return _freshSession;
}

/** The seed bytes used for the current session as a plain number[] for JSON serialisation.
 *  Returns null before startAgent has been called. */
export function getSessionSeed(): number[] | null {
  return _sessionSeed ? Array.from(_sessionSeed) : null;
}

/**
 * Returns true if Pluto has private keys for the given DID string.
 *
 * This catches the "partial Pluto reset" scenario: Pluto was cleared and
 * re-seeded by a QR-flow connection (so getAllMediators() is non-empty and
 * isFreshSession() returns false), but the auto-connect connection's peer DID
 * keys are gone.  Any credential offer encrypted for that peer DID will be
 * permanently stuck at OfferSent because the wallet can't decrypt it.
 */
export async function hasConnectionKeys(walletDid: string): Promise<boolean> {
  if (!_pluto) return false;
  try {
    const did = SDK.Domain.DID.fromString(walletDid);
    const keys = await _pluto.getDIDPrivateKeysByDID(did);
    return Array.isArray(keys) && keys.length > 0;
  } catch {
    return false;
  }
}

/**
 * Initialises the Edge Agent and connects to the mediator.
 * Scoped to `userId` — calling with a different user stops the previous one first.
 * Concurrent calls for the same user share one in-flight promise (Strict Mode safe).
 *
 * @param serverSeed       - HD seed bytes fetched from the server.  Pass null on first
 *                           registration; the hook saves the generated seed afterwards.
 * @param backupToRestore  - Pluto backup fetched from the server.  Restored into a
 *                           fresh Pluto so the student sees their full wallet on any device.
 */
export async function startAgent(
  userId: string,
  serverSeed: number[] | null = null,
  backupToRestore: unknown | null = null
): Promise<SDK.Agent> {
  // Step 1: wait for any in-progress stop to fully complete before opening
  // a new Pluto DB — this is what prevents "Start Pluto first." errors.
  if (_stopPromise) await _stopPromise;

  // Step 2: reuse an already-running agent for this user.
  if (_agent && _currentUserId === userId) return _agent;

  // Step 3: if a concurrent startAgent is already building the agent, share it.
  if (_startPromise) return _startPromise;

  // Step 4: different user's agent still running — stop it first.
  if (_agent && _currentUserId !== userId) {
    await stopAgent();
  }

  if (!MEDIATOR_PEER_DID) {
    throw new Error(
      "VITE_MEDIATOR_PEER_DID is not set.\n" +
        "Run the infrastructure, then:\n" +
        "  node scripts/health-check.mjs\n" +
        "and paste the Mediator Peer DID into your .env file."
    );
  }

  _startPromise = (async () => {
    try {
      const { pluto, apollo } = await getPluto(userId);

      // Detect a fresh Pluto: if no mediators are stored, the IndexedDB was cleared
      // and all DIDComm connection private keys are gone.  Any connectionId stored on
      // the server is therefore stale and needs to be re-established.
      try {
        const storedMediators = await pluto.getAllMediators();
        _freshSession = storedMediators.length === 0;
      } catch {
        _freshSession = false;
      }

      // Restore from server backup when Pluto is fresh (incognito, new device,
      // or after our own tab-close cleanup).  This makes the wallet device-independent.
      if (_freshSession && backupToRestore) {
        try {
          await pluto.restore(backupToRestore as Parameters<SDK.Pluto["restore"]>[0]);
          console.log("[agent] Pluto restored from server backup");
          // After restore Pluto is populated — don't treat connectionId as stale.
          _freshSession = false;
        } catch (e) {
          console.warn("[agent] Failed to restore Pluto backup — starting fresh:", e);
        }
      }

      const castor = new SDK.Castor(apollo);
      const api = new SDK.ApiImpl();
      const didcomm = new SDK.DIDCommWrapper(apollo, castor, pluto);
      const mercury = new SDK.Mercury(castor, didcomm, api);
      const pollux = new SDK.Pollux(apollo, castor);

      const mediatorDID = SDK.Domain.DID.fromString(MEDIATOR_PEER_DID);
      const mediatorStore = new SDK.PublicMediatorStore(pluto);
      const mediatorHandler = new SDK.BasicMediatorHandler(mediatorDID, mercury, mediatorStore);

      // ConnectionsManager v6.6.0 requires: castor, mercury, pluto, pollux, mediatorHandler
      const connectionsManager = new SDK.ConnectionsManager(
        castor,
        mercury,
        pluto,
        pollux,
        mediatorHandler
      );

      const seed = getOrCreateSeed(apollo, serverSeed);

      _agent = new SDK.Agent(
        apollo,
        castor,
        pluto,
        mercury,
        mediatorHandler,
        connectionsManager,
        seed
      );

      await _agent.start();
      return _agent;
    } finally {
      _startPromise = null;
    }
  })();

  return _startPromise;
}

/**
 * Stops the running agent.
 * If `userId` is provided, does nothing if a *different* user's agent is now
 * current — this prevents the logout cleanup from killing a freshly-started
 * agent that belongs to the next logged-in user.
 *
 * Module-level pointers are cleared BEFORE awaiting agent.stop() so that any
 * concurrent call (e.g. startAgent racing with the cleanup) sees null
 * immediately and does not attempt a double-stop.
 */
export async function stopAgent(userId?: string): Promise<void> {
  if (userId && _currentUserId !== userId) return;

  // If nothing is running but a stop is in-flight, wait for it.
  if (!_agent) {
    if (_stopPromise) await _stopPromise;
    return;
  }

  const agent = _agent;

  // Clear references synchronously so concurrent startAgent calls see null
  // immediately and wait on _stopPromise rather than proceeding.
  _agent = null;
  _pluto = null;
  _apollo = null;
  _currentUserId = null;

  // Track the async teardown so startAgent can await it.
  _stopPromise = (async () => {
    try { await agent.stop(); } catch { /* ignore teardown errors */ }
  })();

  try {
    await _stopPromise;
  } finally {
    _stopPromise = null;
  }
}

export function getAgent(): SDK.Agent | null {
  return _agent;
}

// ── Backup / cleanup ───────────────────────────────────────────────────────────

/** Export the current Pluto state as a serialisable backup object.
 *  Returns null if the agent hasn't started yet. */
export async function exportBackup(): Promise<unknown | null> {
  if (!_pluto) return null;
  try {
    return await _pluto.backup();
  } catch (e) {
    console.warn("[backup] exportBackup failed:", e);
    return null;
  }
}

/** Delete the Pluto IndexedDB for the given user.
 *  Called on tab close so no wallet data lingers on foreign devices.
 *  Stops the agent first to close all open database connections.
 */
export async function deleteWalletDatabase(userId: string): Promise<void> {
  await stopAgent(userId);
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(`diploma-wallet-${userId}`);
    req.onsuccess = () => { console.log("[cleanup] Wallet database deleted"); resolve(); };
    req.onerror   = () => resolve();
    req.onblocked = () => resolve();
  });
}

// ── Credential operations ──────────────────────────────────────────────────────

export async function getAllCredentials(): Promise<SDK.Domain.Credential[]> {
  if (!_pluto) return [];
  return _pluto.getAllCredentials();
}

/**
 * Accepts a DIDComm OOB invitation URL.
 */
export async function acceptInvitation(invitationUrl: string): Promise<void> {
  if (!_agent) throw new Error("Agent not started");
  const parsed = await _agent.parseOOBInvitation(new URL(invitationUrl));
  await _agent.acceptDIDCommInvitation(parsed);
}

/**
 * Registers listeners for incoming DIDComm messages.
 * Returns an unsubscribe function.
 *
 * EventCallback in v6.6.0: (arg: Message[] | DIDPair | Credential) => void
 * We type-guard with Array.isArray to handle only message events.
 */
export function registerMessageListener(
  onCredentialIssued: (credential: SDK.Domain.Credential, thid: string) => void,
  onProofRequest: (request: SDK.Domain.Message) => void
): () => void {
  const agent = _agent;
  if (!agent) return () => {};

  const handler: SDK.EventCallback = (arg) => {
    // Only handle Message[] events; ignore DIDPair and Credential events
    if (!Array.isArray(arg)) return;
    const messages = arg as SDK.Domain.Message[];
    console.log(`[wallet] MESSAGE event: ${messages.length} message(s)`, messages.map((m) => m.piuri));

    void (async () => {
      for (const message of messages) {
        // Credential Offer — auto-accept
        if (message.piuri === "https://didcomm.org/issue-credential/3.0/offer-credential") {
          console.log("[wallet] Accepting credential offer, thid:", message.thid);
          try {
            const offer = SDK.OfferCredential.fromMessage(message);
            const request = await agent.prepareRequestCredentialWithIssuer(offer);
            await agent.sendMessage(request.makeMessage());
            console.log("[wallet] Credential request sent successfully");
          } catch (e) {
            console.error("[wallet] Failed to accept credential offer:", e);
          }
        }

        // Issued Credential — store it
        if (message.piuri === "https://didcomm.org/issue-credential/3.0/issue-credential") {
          console.log("[wallet] Processing issued credential, thid:", message.thid);
          try {
            const issued = SDK.IssueCredential.fromMessage(message);
            const credential = await agent.processIssuedCredentialMessage(issued);
            console.log("[wallet] Credential stored successfully");
            onCredentialIssued(credential, message.thid ?? message.id);
          } catch (e) {
            console.error("[wallet] Failed to process issued credential:", e);
          }
        }

        // Proof Request — surface to UI
        if (message.piuri === "https://didcomm.atalaprism.io/present-proof/3.0/request-presentation") {
          onProofRequest(message);
        }
      }
    })();
  };

  agent.addListener(SDK.ListenerKey.MESSAGE, handler);
  return () => agent.removeListener(SDK.ListenerKey.MESSAGE, handler);
}

/**
 * Creates and sends a Verifiable Presentation in response to a proof request.
 */
export async function sendPresentation(
  requestMessage: SDK.Domain.Message,
  credential: SDK.Domain.Credential
): Promise<void> {
  const agent = _agent;
  if (!agent) throw new Error("Agent not started");

  const request = SDK.RequestPresentation.fromMessage(requestMessage);
  const presentation = await agent.createPresentationForRequestProof(request, credential);
  await agent.sendMessage(presentation.makeMessage());
}

// ── Local DID info ─────────────────────────────────────────────────────────────

export async function getMediatorDid(): Promise<string | null> {
  if (!_pluto) return null;
  const mediators = await _pluto.getAllMediators();
  return mediators[0]?.mediatorDID?.toString() ?? null;
}

export async function getPeerDids(): Promise<SDK.Domain.DID[]> {
  if (!_pluto) return [];
  return _pluto.getAllPeerDIDs().then((dids) => dids.map((d) => d.did));
}

