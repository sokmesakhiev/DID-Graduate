/**
 * Cardano VC hash writer service.
 *
 * Flow:
 *   1. Receive the issued VC JSON from the issuer portal
 *   2. Canonicalize + SHA-256 hash the VC
 *   3. Build a Cardano transaction with CIP-0020 metadata (label 674)
 *   4. Sign and submit via Blockfrost
 *   5. Return the tx hash so the issuer portal can display a Cardanoscan link
 *
 * Security note: The wallet mnemonic lives only in the server environment
 * variable and is never sent to the client or written to logs.
 */
import crypto from "node:crypto";
import { BlockFrostAPI } from "@blockfrost/blockfrost-js";
import { MeshWallet, Transaction, BlockfrostProvider } from "@meshsdk/core";
import { CARDANO_METADATA_LABEL, CardanoVcHashPayload, CardanoWriteResult } from "@university-diplomas/common";

// ── Singleton Blockfrost client ────────────────────────────────────────────────
let _blockfrost: BlockFrostAPI | null = null;

function getBlockfrost(): BlockFrostAPI {
  if (!_blockfrost) {
    const projectId = process.env.BLOCKFROST_PROJECT_ID;
    if (!projectId) throw new Error("BLOCKFROST_PROJECT_ID env var is not set");
    _blockfrost = new BlockFrostAPI({ projectId });
  }
  return _blockfrost;
}

// ── Singleton Mesh wallet ──────────────────────────────────────────────────────
let _wallet: MeshWallet | null = null;

async function getWallet(): Promise<MeshWallet> {
  if (!_wallet) {
    const mnemonic = process.env.CARDANO_WALLET_MNEMONIC;
    if (!mnemonic) throw new Error("CARDANO_WALLET_MNEMONIC env var is not set");

    const network = process.env.CARDANO_NETWORK === "mainnet" ? 1 : 0;
    const provider = new BlockfrostProvider(
      process.env.BLOCKFROST_PROJECT_ID ?? ""
    );

    _wallet = new MeshWallet({
      networkId: network,
      fetcher: provider,
      submitter: provider,
      key: {
        type: "mnemonic",
        words: mnemonic.trim().split(/\s+/),
      },
    });
  }
  return _wallet;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Computes a SHA-256 hash of the VC (deterministic JSON serialisation).
 *
 * We sort keys before hashing to ensure the same credential always produces
 * the same hash regardless of JS object key ordering.
 */
export function hashVc(vc: unknown): string {
  const canonical = JSON.stringify(vc, Object.keys(vc as object).sort());
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Writes the VC hash to Cardano as metadata on a minimal ADA transaction.
 *
 * The metadata structure follows CIP-0020 (label 674) and includes:
 *   - vcHash: hex-encoded SHA-256 of the canonical VC JSON
 *   - vcId: the VC's id field
 *   - universityDid: issuer DID for easy on-chain lookup
 *   - studentId: non-PII identifier
 *   - issuedAt: ISO timestamp
 *
 * @returns Cardano transaction hash + preprod.cardanoscan.io URL
 */
export async function writeVcHashToCardano(
  payload: CardanoVcHashPayload
): Promise<CardanoWriteResult> {
  const wallet = await getWallet();
  const addresses = await wallet.getUsedAddresses();
  const changeAddress = addresses[0] ?? (await wallet.getChangeAddress());

  // Cardano metadata values must be <= 64 bytes each.
  // The SHA-256 hex is 64 chars — exactly within the limit.
  const metadata = {
    [CARDANO_METADATA_LABEL]: {
      msg: ["University Diploma VC Hash Receipt"],
      vcHash: payload.vcHash,          // 64-char hex — within 64-byte limit
      vcId: truncate(payload.vcId, 64),
      universityDid: truncate(payload.universityDid, 64),
      studentId: truncate(payload.studentId, 64),
      issuedAt: payload.issuedAt,
    },
  };

  const tx = new Transaction({ initiator: wallet });

  // Send minimum ADA back to self (this is the cheapest valid transaction)
  tx.sendLovelace(changeAddress, "1500000"); // 1.5 ADA min-UTXO
  tx.setMetadata(CARDANO_METADATA_LABEL, metadata[CARDANO_METADATA_LABEL]);

  const unsignedTx = await tx.build();
  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);

  const network = process.env.CARDANO_NETWORK ?? "preprod";
  const baseUrl =
    network === "mainnet"
      ? "https://cardanoscan.io"
      : "https://preprod.cardanoscan.io";

  return {
    txHash,
    cardanoscanUrl: `${baseUrl}/transaction/${txHash}`,
  };
}

/** Truncates a string to at most maxLen bytes (UTF-8). */
function truncate(value: string, maxLen: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxLen) return value;
  return encoded.subarray(0, maxLen).toString("utf8");
}

/**
 * Writes a VC revocation notice to Cardano as metadata on a minimal ADA transaction.
 * References the original vcHash so the two transactions are linkable on-chain.
 */
export async function writeRevocationToCardano(params: {
  vcHash: string;
  vcId: string;
  universityDid: string;
  studentId: string;
  reason?: string;
}): Promise<CardanoWriteResult> {
  const wallet = await getWallet();
  const addresses = await wallet.getUsedAddresses();
  const changeAddress = addresses[0] ?? (await wallet.getChangeAddress());

  const metadata = {
    msg: ["University Diploma VC Revocation"],
    vcHash: params.vcHash,
    vcId: truncate(params.vcId, 64),
    universityDid: truncate(params.universityDid, 64),
    studentId: truncate(params.studentId, 64),
    revokedAt: new Date().toISOString(),
    ...(params.reason ? { reason: truncate(params.reason, 64) } : {}),
  };

  const tx = new Transaction({ initiator: wallet });
  tx.sendLovelace(changeAddress, "1500000");
  tx.setMetadata(CARDANO_METADATA_LABEL, metadata);

  const unsignedTx = await tx.build();
  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);

  const network = process.env.CARDANO_NETWORK ?? "preprod";
  const baseUrl =
    network === "mainnet"
      ? "https://cardanoscan.io"
      : "https://preprod.cardanoscan.io";

  return {
    txHash,
    cardanoscanUrl: `${baseUrl}/transaction/${txHash}`,
  };
}
