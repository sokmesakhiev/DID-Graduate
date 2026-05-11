/**
 * Unit tests for studentStore — exercises every function added in the last
 * session without touching the real data/students.json file.
 *
 * Strategy: point DATA_DIR at a per-test temp directory by mocking the path
 * resolution before importing the module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Temp store setup ──────────────────────────────────────────────────────────

let tmpDir: string;
let storeFile: string;

function seedStore(students: unknown[] = []) {
  writeFileSync(storeFile, JSON.stringify(students, null, 2), "utf-8");
}

// We need to reset the module between tests so each test gets a clean module
// with its own DATA_DIR pointing to the temp directory.
// We do this by mocking the `path.resolve` calls that build STORE_PATH.

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStudent(overrides: Record<string, unknown> = {}) {
  return {
    id: "stu-1",
    email: "alice@uni.edu",
    passwordHash: "$2b$10$dummy",
    name: "Alice Test",
    studentNumber: "S001",
    createdAt: new Date().toISOString(),
    issuedCredentials: [],
    ...overrides,
  };
}

function makeCred(overrides: Record<string, unknown> = {}) {
  return {
    credentialRecordId: "rec-1",
    degree: "BSc Computer Science",
    graduationDate: "2024-06-01",
    issuedAt: new Date().toISOString(),
    revoked: false,
    ...overrides,
  };
}

// ── Module under test (imported fresh per suite via dynamic import) ────────────

async function loadStore(dir: string) {
  // Reset module registry so re-import picks up the mocked path
  vi.resetModules();

  // Patch __dirname inside studentStore by mocking the path.resolve call.
  // The module computes: resolve(__dirname, "../../data") → we intercept
  // resolve to return our temp dir when the second arg is "../../data".
  vi.mock("path", async (importOriginal) => {
    const original = await importOriginal<typeof import("path")>();
    return {
      ...original,
      resolve: (...args: string[]) => {
        // Only intercept the DATA_DIR computation
        if (args[args.length - 1] === "../../data") return dir;
        return original.resolve(...args);
      },
    };
  });

  return import("../services/studentStore.js");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("studentStore", () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    storeFile = join(tmpDir, "students.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── updateDeliveryState ─────────────────────────────────────────────────────

  describe("updateDeliveryState", () => {
    it("persists deliveryState and deliveryCheckedAt", async () => {
      const student = makeStudent({ issuedCredentials: [makeCred()] });
      seedStore([student]);
      const store = await loadStore(tmpDir);

      store.updateDeliveryState("stu-1", "rec-1", "CredentialSent");

      const [updated] = store.getIssuedCredentials("stu-1");
      expect(updated.deliveryState).toBe("CredentialSent");
      expect(updated.deliveryCheckedAt).toBeDefined();
    });

    it("throws when student not found", async () => {
      seedStore([]);
      const store = await loadStore(tmpDir);
      expect(() => store.updateDeliveryState("nope", "rec-1", "OfferSent")).toThrow("Student not found");
    });

    it("throws when credential not found", async () => {
      seedStore([makeStudent()]);
      const store = await loadStore(tmpDir);
      expect(() => store.updateDeliveryState("stu-1", "no-cred", "OfferSent")).toThrow("Credential not found");
    });
  });

  // ── markCredentialFailed ────────────────────────────────────────────────────

  describe("markCredentialFailed", () => {
    it("sets failedAt and failureReason", async () => {
      const student = makeStudent({ issuedCredentials: [makeCred()] });
      seedStore([student]);
      const store = await loadStore(tmpDir);

      store.markCredentialFailed("stu-1", "rec-1", "Offer stuck for 48h");

      const [cred] = store.getIssuedCredentials("stu-1");
      expect(cred.failedAt).toBeDefined();
      expect(cred.failureReason).toBe("Offer stuck for 48h");
    });

    it("is idempotent — second call updates reason", async () => {
      const student = makeStudent({ issuedCredentials: [makeCred()] });
      seedStore([student]);
      const store = await loadStore(tmpDir);

      store.markCredentialFailed("stu-1", "rec-1", "first reason");
      store.markCredentialFailed("stu-1", "rec-1", "updated reason");

      const [cred] = store.getIssuedCredentials("stu-1");
      expect(cred.failureReason).toBe("updated reason");
    });
  });

  // ── updateIssuedCredentialRevocationCardano ─────────────────────────────────

  describe("updateIssuedCredentialRevocationCardano", () => {
    it("stores revocation tx hash and URL", async () => {
      const student = makeStudent({ issuedCredentials: [makeCred()] });
      seedStore([student]);
      const store = await loadStore(tmpDir);

      store.updateIssuedCredentialRevocationCardano("stu-1", "rec-1", "txabc123", "https://preprod.cardanoscan.io/transaction/txabc123");

      const [cred] = store.getIssuedCredentials("stu-1");
      expect(cred.cardanoRevocationTxHash).toBe("txabc123");
      expect(cred.cardanoRevocationUrl).toBe("https://preprod.cardanoscan.io/transaction/txabc123");
    });
  });

  // ── markRevocationPending ───────────────────────────────────────────────────

  describe("markRevocationPending", () => {
    it("sets revocationPendingAt and reason, leaves revoked=false", async () => {
      const student = makeStudent({ issuedCredentials: [makeCred()] });
      seedStore([student]);
      const store = await loadStore(tmpDir);

      store.markRevocationPending("stu-1", "rec-1", "Academic fraud");

      const [cred] = store.getIssuedCredentials("stu-1");
      expect(cred.revocationPendingAt).toBeDefined();
      expect(cred.revocationReason).toBe("Academic fraud");
      expect(cred.revoked).toBe(false);
    });
  });

  // ── confirmRevocation ───────────────────────────────────────────────────────

  describe("confirmRevocation", () => {
    it("sets revoked=true and revocationConfirmedAt", async () => {
      const cred = makeCred({ revocationPendingAt: new Date().toISOString() });
      const student = makeStudent({ issuedCredentials: [cred] });
      seedStore([student]);
      const store = await loadStore(tmpDir);

      store.confirmRevocation("stu-1", "rec-1");

      const [updated] = store.getIssuedCredentials("stu-1");
      expect(updated.revoked).toBe(true);
      expect(updated.revocationConfirmedAt).toBeDefined();
    });
  });

  // ── issuance fields stored ──────────────────────────────────────────────────

  describe("IssuedCredential issuance fields", () => {
    it("stores and retrieves issuingDid, schemaId, studentName etc.", async () => {
      const store = await loadStore(tmpDir);
      seedStore([makeStudent()]);

      store.addIssuedCredential("stu-1", {
        credentialRecordId: "rec-new",
        degree: "MSc AI",
        graduationDate: "2025-07-01",
        issuedAt: new Date().toISOString(),
        revoked: false,
        issuingDid: "did:prism:abc",
        schemaId: "http://schema/v1",
        studentName: "Alice Test",
        studentIdField: "S001",
        universityName: "Test University",
      });

      const creds = store.getIssuedCredentials("stu-1");
      const rec = creds.find((c) => c.credentialRecordId === "rec-new");
      expect(rec?.issuingDid).toBe("did:prism:abc");
      expect(rec?.schemaId).toBe("http://schema/v1");
      expect(rec?.studentName).toBe("Alice Test");
      expect(rec?.universityName).toBe("Test University");
    });
  });
});
