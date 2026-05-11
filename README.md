# University Diploma Verifiable Credentials — Setup Guide

This system lets a university **issue digital diplomas** that students can store in a browser wallet and employers can **instantly verify** — without calling the university. Everything is cryptographically signed. No PDFs, no fraud.

> **No prior knowledge of blockchain, DIDs, or cryptography is required to run this.** Just follow the steps in order.

---

## What is a DID?

A **DID** (Decentralised Identifier) is like an email address that nobody can fake or take away from you, because it is controlled by a private key rather than a central server. In this system:

- The **university** has a DID — it is the issuer of diplomas.
- The **student** has a DID — it is the recipient of their diploma credential.
- When the university signs a diploma with its DID, anyone can verify the signature is genuine without contacting the university.

---

## How credential issuance works in detail

### Happy path — wallet is open

1. Admin clicks **Issue Diploma** in the Students tab and submits the form.
2. The Issuer Portal calls the Issuer API (`POST /api/agent/issue-credentials/credential-offers`) with the student's `connectionId`, the issuing DID, schema ID, and claims. It also calls `POST /api/students/:id/credentials` to persist the credential record including the `issuingDid`.
3. The Cloud Agent creates the offer and pushes it over DIDComm through the mediator to the student's wallet.
4. The student wallet (Hyperledger Identus Edge Agent SDK running in the browser) auto-accepts the offer and stores the signed JWT credential in Pluto (the in-browser credential store).
5. The wallet fires `POST /api/students/:id/credentials/:recordId/wallet-confirmed` to notify the Issuer API that it has received the credential. This is the trigger for the Cardano anchor.
6. The Issuer API computes a SHA-256 hash of the credential, submits a Cardano preprod transaction with the hash in metadata (label 674), and stores the `cardanoTxHash` and `cardanoscanUrl` on the credential record.
7. The credential appears in the student's **My Diplomas → Verified Diplomas** tab with a **⛓ On-chain anchor** link pointing to Cardanoscan. This takes approximately 30 seconds from delivery.

> **Startup catch-up**: On every wallet login, the wallet cross-references its locally stored credentials (Pluto) against the server's records. Any credential that has an `issuingDid` but no `cardanoTxHash` yet automatically re-triggers the `wallet-confirmed` callback. This ensures anchoring completes even if the wallet was offline when the credential first arrived.

### Offline student — diploma queued

If the student's wallet is not open (or has never been opened), there is no live DIDComm channel for the offer to travel through. Instead:

1. The Issuer Portal calls `POST /api/students/:id/diplomas/pending` to store the diploma in `data/pending-diplomas.json` on the Issuer API server.
2. The portal shows **"Diploma Queued"** — no further action needed.
3. When the student next opens their wallet, the wallet calls `POST /api/students/:id/diplomas/deliver`.
4. The Issuer API waits for the DIDComm handshake to complete (up to 60 s), then issues all queued diplomas one by one using `issueCredentialNow()`.
5. Successfully issued entries are removed from `pending-diplomas.json`. Failed entries stay and will retry on the next wallet open.

### Stale connection fallback

If a student has a `connectionId` stored but the Cloud Agent no longer recognises it (e.g. after a container restart):

- The wallet calls `GET /api/students/:id/connection/verify` on startup. If the agent returns 404, the server clears the `connectionId` and the wallet auto-establishes a fresh connection.
- If the Issuer Portal tries to issue directly and the Cloud Agent rejects the offer (any non-2xx), the portal automatically falls back to queuing the diploma instead of showing an error.

---

## How credential revocation works in detail

Revocation is a **two-phase** process to keep the issuer portal and the student wallet in sync.

### Phase 1 — Issuer initiates

1. Admin clicks **Revoke** on a credential in the Students tab, enters a reason, and confirms.
2. The Issuer API calls `PATCH /credential-status/revoke-credential/:recordId` on the Cloud Agent, which flips the status list bit on-chain (or in the local registry in dev mode).
3. The credential record in `students.json` is updated: `revocationPendingAt` is set to the current timestamp and `revocationReason` is stored. `revoked` remains `false`.
4. The Issuer Portal immediately shows the credential as **Revoking…** (yellow badge).

### Phase 2 — Student wallet acknowledges

5. The student wallet polls `GET /api/students/:id/credentials` every **10 seconds**.
6. When it detects a credential with `revocationPendingAt` set but `revocationConfirmedAt` unset, it calls `POST /api/students/:id/credentials/:recordId/revocation-confirmed`.
7. The Issuer API sets `revoked: true` and `revocationConfirmedAt` on the credential record. It also writes a **revocation anchor** to Cardano (a second transaction referencing the original `vcHash`) and stores `cardanoRevocationTxHash` and `cardanoRevocationUrl`.
8. The Issuer Portal sees `revoked: true` on its next poll and updates the badge to **Revoked** (red), showing the confirmation timestamp and both Cardano anchor links (issuance + revocation).
9. In the student wallet, the diploma moves from **Verified Diplomas** to the **Revoked** tab (sorted newest-first by `revocationConfirmedAt`), displaying both the issuance anchor and the revocation anchor.

> **Why two phases?** The status list bit is flipped immediately (so verifiers see the revocation at once), but the student wallet needs a chance to update its local Pluto store. The two-phase design ensures the issuer portal only shows **Revoked** once the student's device has actually processed it — preventing a race condition where the wallet still shows the credential as valid while the portal shows it as revoked.

---

## How the flow works (plain English)

1. The **student** registers an account in the Student Wallet (email + password). On first login the wallet auto-connects to the university's issuer agent via DIDComm.
2. The **university admin** opens the Issuer Portal → **Students** tab and sees all registered students. Connected students show a green "Wallet linked" badge.
3. The admin clicks **Issue Diploma** next to a student, fills in degree details, and clicks **Issue Diploma ✓**.
   - If the student's wallet is **open**: the credential is delivered in real time (≤30 s).
   - If the student's wallet is **offline**: the diploma is queued and auto-delivered the next time they open their wallet.
4. The diploma appears in the student's **My Diplomas** page, cryptographically signed by the university's DID.
5. An **employer** opens the Verifier Portal and starts a verification session. The student presents their diploma from the wallet.
6. The verifier portal checks the signature and displays ✓ Verified with all the diploma fields.

### Revocation

If a diploma must be revoked (e.g. the student withdrew or it was issued in error):

1. Issuer Portal → **Students** → click **Credentials** next to the student → click **Revoke** on the credential → enter a reason.
2. The revocation bit is flipped immediately in the agent. The diploma moves to **Revoking…** state.
3. The student's wallet polls every 10 seconds and automatically acknowledges the revocation. Once confirmed, the diploma moves from the **Verified Diplomas** tab to the **Revoked** tab (most recently revoked shown first).
4. A **revocation anchor** (second Cardano transaction) is written automatically. Both the issuance and revocation anchor links appear in the Issuer Portal (Dashboard + Students) and in the student wallet's Revoked tab.
5. The Issuer Portal **Dashboard** reflects the final **Revoked** state with the confirmation timestamp.

---

## Architecture overview

```
Issuer Portal (port 5173)  ──REST──►  Issuer API (port 3002)  ──►  Issuer Cloud Agent (port 8000)
                                                                              │
                                                               DIDComm (encrypted messaging)
                                                                              │
Student Wallet (port 5174) ◄──────────────────────────────────────────────────
                                  via Mediator (port 8080)

Verifier Portal (port 5175) ──REST──►  Verifier Cloud Agent (port 9000)
```

All the cryptography and DIDComm messaging is handled by **Hyperledger Identus** (the Cloud Agent). The frontends are plain React apps.

---

## What you need installed

| Tool | Why | Install |
|------|-----|---------|
| **Docker Desktop** | Runs all backend services | [docker.com/get-started](https://www.docker.com/get-started) |
| **Node.js 20+** | Runs the frontend dev servers | [nodejs.org](https://nodejs.org) |
| **pnpm 9+** | Package manager for this monorepo | `npm install -g pnpm` |
| **Git Bash** (Windows only) | Runs the `.sh` setup scripts | Included with [Git for Windows](https://git-scm.com/download/win) |

After installing Docker Desktop, make sure it is **running** (you should see the Docker icon in your system tray).

---

## Step 1 — Clone and install dependencies

Open a terminal in the project folder and run:

```bash
pnpm install
```

This installs all JavaScript dependencies for every app in the monorepo. It takes about a minute the first time.

---

## Step 2 — Create your environment file

```bash
cp .env.example .env
```

Now open `.env` in a text editor. It contains all the settings for the system. Most values are pre-filled for local development. You **must** fill in the following:

### Required for Cardano on-chain receipts (optional feature)

```env
# Get a free API key at https://blockfrost.io
# Click "Add Project", select "Cardano preprod", copy the project ID
BLOCKFROST_PROJECT_ID=preprodXXXXXXXXXXXXXXXXXX

# A 24-word seed phrase for a Cardano preprod wallet
# The wallet pays a tiny transaction fee each time a diploma hash is written on-chain
# Get free test ADA from: https://docs.cardano.org/cardano-testnets/tools/faucet
CARDANO_WALLET_MNEMONIC="word1 word2 word3 ... word24"
```

> If you skip the Cardano section, diploma issuance still works — the on-chain hash step just does nothing.

### Set your university name

```env
VITE_UNIVERSITY_NAME=MIT
```

Leave all other values as-is for now. The next steps will auto-fill the remaining blank values.

---

## Step 3 — Start the backend services

```bash
pnpm run infra:dev
```

This starts the following Docker containers:

| Container | What it does |
|-----------|-------------|
| `issuer-agent` | Cloud agent that issues diploma credentials (port 8000) |
| `verifier-agent` | Cloud agent that verifies credentials (port 9000) |
| `mediator` | Routes encrypted DIDComm messages between agents and wallets (port 8080) |
| `prism-node` | Anchors DIDs to a local in-memory ledger (simulates Cardano) |
| `postgres` | Database for the cloud agents |
| `mongo` | Database for the mediator |

**Wait about 60 seconds** for all containers to become ready, then run:

```bash
pnpm run health
```

You should see something like:

```
✅  Issuer Cloud Agent  : OK
✅  Verifier Cloud Agent: OK
✅  Mediator            : OK

Mediator Peer DID:
did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQ...
```

Copy the full `did:peer:2.Ez6...` value. Open `.env` and paste it:

```env
VITE_MEDIATOR_PEER_DID=did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQ...
```

> **Why?** The student wallet needs to know the mediator's address to receive messages. The mediator DID encodes that address in a cryptographic format.

---

## Step 4 — Create the university DID and diploma schema

Run these two scripts **in order**:

```bash
bash scripts/01-init-university-did.sh
```

This creates a cryptographic identity (DID) for the university and publishes it to the local ledger. When it finishes it automatically writes `VITE_UNIVERSITY_DID=did:prism:...` into your `.env` file.

```bash
bash scripts/02-register-diploma-schema.sh
```

This registers the diploma data structure (what fields a diploma contains) with the issuer agent. When it finishes it automatically writes `VITE_DIPLOMA_SCHEMA_ID=http://localhost:...` into your `.env` file.

After both scripts, your `.env` should now have the following filled in:

```env
VITE_MEDIATOR_PEER_DID=did:peer:2...     ← from Step 3
VITE_UNIVERSITY_DID=did:prism:0ca3...    ← from script 01
VITE_DIPLOMA_SCHEMA_ID=http://localhost:8085/schema-registry/schemas/...  ← from script 02
```

---

## Step 5 — Start the applications

```bash
pnpm run dev
```

This starts four development servers in parallel. Once they are ready, open these URLs in your browser:

| App | URL | Who uses it |
|-----|-----|-------------|
| Issuer Portal | http://localhost:5173 | University admin |
| Student Wallet | http://localhost:5174 | Student |
| Verifier Portal | http://localhost:5175 | Employer / verifier |

> Keep the terminal open. Press `Ctrl+C` to stop all servers.

---

## Step 6 — Issue your first diploma (end-to-end test)

### 6a. Register a student account (Student Wallet)

1. Open **http://localhost:5174** in a browser tab.
2. Click **Register** and create an account with your name, email, and password.
3. After login, the wallet initialises and **automatically connects** to the university issuer agent (this takes 5–15 seconds). You'll see "Wallet ready" when done.

### 6b. Issue the diploma (Issuer Portal — Students tab)

1. Open **http://localhost:5173** in a browser tab.
2. Click **Students** in the top navigation bar. You should see the student you just registered with a green **Wallet linked** badge.
3. Click **Issue Diploma** next to their name.
4. Fill in degree, graduation date, and optional GPA.
5. Click **Issue Diploma ✓**.
6. The modal will show progress: *Creating offer → Waiting for wallet → Diploma Issued!*

> If the student wallet is closed, the diploma is automatically queued. Next time the student opens their wallet it will be delivered.

### 6c. View the diploma (Student Wallet)

1. Switch to the Student Wallet tab (http://localhost:5174).
2. The diploma should appear under **Verified Diplomas** within 30 seconds.
3. Revoked diplomas move to the **Revoked** tab automatically once the wallet acknowledges the revocation.

### 6d. Verify the diploma (Verifier Portal)

1. Open **http://localhost:5175** in a browser tab.
2. Click **Start Verification Session**. A QR code and invitation URL appear.
3. In the Student Wallet, click **Present Diploma** in the top navigation bar.
4. In the Verifier Portal, copy the invitation URL and share it with the student (or the student scans the QR code).
5. Once the student's wallet connects, a **Proof Request Received** banner appears in the wallet. Select the diploma and click **Send Presentation**.
6. The Verifier Portal should show ✅ **Verified** with all the diploma fields.

---

## Issuer Portal — pages

| Page | What it does |
|------|-------------|
| **Dashboard** | Lists all issued credentials with live status (Active / Revoking / Revoked), filter tabs, search, and Cardano tx hash |
| **Students** | Lists registered students with avatars and wallet status; issue diplomas directly or queue for offline students; view and revoke credentials per student |
| **Connections** | Raw DIDComm connection list (debugging) |

## Student Wallet — pages

| Page | What it does |
|------|-------------|
| **My Diplomas** | Shows all credentials split into **Verified Diplomas** and **Revoked** tabs; displays wallet status and issuer connection badge; revoked credentials sorted newest-first |
| **Present Diploma** | Receives incoming proof requests from a verifier; lets the student select a diploma and send a cryptographic presentation |

## Verifier Portal — pages

| Page | What it does |
|------|-------------|
| **Verify Diploma** | Starts a verification session (QR code + invitation URL); waits for the student to connect and send a presentation; shows ✅ Verified or ❌ Failed with all credential fields and optional Cardano on-chain confirmation |
| **History** | Lists all past verification sessions with their results |

---

## Troubleshooting

### "Agent failed to start" in the Student Wallet
- Make sure `VITE_MEDIATOR_PEER_DID` is set in `.env` and you restarted `pnpm run dev` after editing the file.
- Try clearing your browser's site data: DevTools → Application → Storage → **Clear site data**.

### "CORS error" in the browser console
- The issuer-api backend must be running on port 3002. Check the terminal where you ran `pnpm run dev`.

### Diploma never arrives in the wallet
- The mediator must be healthy. Run `pnpm run health` again.
- If the student wallet was offline when the diploma was issued, it will be auto-delivered the next time they open the wallet — no action needed.
- Check Docker is still running: `docker ps` should show 6 containers.

### Scripts fail on Windows
- Run the `.sh` scripts inside **Git Bash**, not PowerShell or cmd.
- Right-click the `scripts/` folder → Git Bash Here, then run `bash 01-init-university-did.sh`.

### Containers fail to start
```bash
pnpm run infra:logs
```
Common causes: another service is using ports 8000, 9000, or 8080. Stop it, then re-run `pnpm run infra:dev`.

### Starting fresh (reset everything)
```bash
pnpm run infra:stop
docker volume prune -f
pnpm run infra:dev
```
Then re-run Steps 3–4.

---

## Available commands

| Command | What it does |
|---------|-------------|
| `pnpm run infra:dev` | Start all Docker backend containers |
| `pnpm run infra:stop` | Stop and remove all containers |
| `pnpm run infra:logs` | Stream all container logs |
| `pnpm run health` | Check that all services are healthy |
| `pnpm run dev` | Start all four apps (Issuer Portal, Student Wallet, Verifier Portal, Issuer API) |
| `pnpm run dev:issuer` | Start only the Issuer Portal + API |
| `pnpm run dev:wallet` | Start only the Student Wallet |
| `pnpm run dev:verifier` | Start only the Verifier Portal |
| `pnpm run build` | Build all apps for production |

---

## How Cardano anchoring works (optional reading)

Cardano anchoring uses a **wallet-confirmed callback** architecture — the anchor is only written once the student's wallet has provably received and stored the credential.

### Issuance anchor

1. After the student wallet stores a new credential, it calls `POST /api/students/:id/credentials/:recordId/wallet-confirmed`.
2. The Issuer API computes a SHA-256 hash of the credential (deterministic JSON serialisation), then submits a Cardano preprod transaction with the hash in metadata under label `674` (CIP-0020).
3. The `cardanoTxHash` and `cardanoscanUrl` are stored on the credential record and surfaced in both the Issuer Portal (Students page, Dashboard) and the student wallet (diploma card anchor link).

### Revocation anchor

1. After the student wallet acknowledges a revocation, the Issuer API writes a second Cardano transaction referencing the original `vcHash` with a revocation notice.
2. The `cardanoRevocationTxHash` and `cardanoRevocationUrl` are stored separately and shown as a distinct link in both portals.

### Why wallet-confirmed?

Anchoring on wallet-confirmed (rather than on `CredentialSent`) guarantees the credential has actually been received and stored before creating a permanent on-chain record. This prevents orphaned anchors for credentials that were offered but never accepted.

### Startup catch-up

If the wallet was offline when the credential arrived, the startup confirmation loop re-fires `wallet-confirmed` for any credential that has an `issuingDid` but no `cardanoTxHash` yet — so anchoring completes the next time the student opens their wallet.

---

## Repo structure

```
identus/
├── apps/
│   ├── issuer-api/          Express backend (proxy to Cloud Agent + Cardano writer)
│   ├── issuer-portal/       University admin React app (port 5173)
│   ├── student-wallet/      Student browser wallet (port 5174)
│   └── verifier-portal/     Employer verifier React app (port 5175)
├── packages/
│   └── common/              Shared TypeScript types and diploma JSON schema
├── infrastructure/
│   ├── docker-compose.dev.yml     Local dev (in-memory PRISM node)
│   └── docker-compose.preprod.yml Cardano preprod (real on-chain DIDs)
├── scripts/
│   ├── health-check.mjs           Check all services + print Mediator DID
│   ├── 01-init-university-did.sh  Create + publish university DID
│   └── 02-register-diploma-schema.sh  Register diploma schema
└── .env.example             Copy to .env and fill in your values
```
