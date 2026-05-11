/**
 * Unit tests for the delivery sweep logic extracted from index.ts.
 *
 * The sweep function itself lives inside the app.listen callback so we can't
 * import it directly. Instead we extract the pure decision logic into a helper
 * and test that. This file also tests the conditions used in the sweep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssuedCredential } from "../services/studentStore.js";

// ── Pure logic extracted from the sweep ──────────────────────────────────────
// (mirrors the conditions in index.ts sweepDeliveryStates)

const STALE_THRESHOLD_H = 48;
const REVOCATION_ACK_TIMEOUT_H = 7 * 24;

function shouldAutoFail(
  cred: IssuedCredential,
  agentState: string,
  nowMs: number
): { fail: boolean; reason: string } {
  if (agentState === "ProblemReportReceived") {
    return { fail: true, reason: "Holder sent a problem report — credential was rejected" };
  }
  if (agentState === "OfferSent" || agentState === "OfferPending") {
    const hoursElapsed = (nowMs - new Date(cred.issuedAt).getTime()) / 3_600_000;
    if (hoursElapsed >= STALE_THRESHOLD_H) {
      return {
        fail: true,
        reason: `Offer stuck in ${agentState} for ${Math.floor(hoursElapsed)}h — student wallet never responded`,
      };
    }
  }
  return { fail: false, reason: "" };
}

function shouldAutoConfirmRevocation(
  cred: IssuedCredential,
  nowMs: number
): boolean {
  if (!cred.revocationPendingAt || cred.revoked) return false;
  const hoursElapsed = (nowMs - new Date(cred.revocationPendingAt).getTime()) / 3_600_000;
  return hoursElapsed >= REVOCATION_ACK_TIMEOUT_H;
}

function shouldSkipDeliveryCheck(cred: IssuedCredential, nowMs: number): boolean {
  if (!cred.deliveryCheckedAt) return false;
  const age = nowMs - new Date(cred.deliveryCheckedAt).getTime();
  return age < 25 * 60 * 1000;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function baseCred(overrides: Partial<IssuedCredential> = {}): IssuedCredential {
  return {
    credentialRecordId: "rec-1",
    degree: "BSc",
    graduationDate: "2024-06-01",
    issuedAt: hoursAgo(1),
    revoked: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("delivery sweep — shouldAutoFail", () => {
  it("flags ProblemReportReceived immediately regardless of age", () => {
    const cred = baseCred({ issuedAt: minutesAgo(5) });
    const result = shouldAutoFail(cred, "ProblemReportReceived", Date.now());
    expect(result.fail).toBe(true);
    expect(result.reason).toMatch(/problem report/i);
  });

  it("does NOT flag OfferSent before 48h", () => {
    const cred = baseCred({ issuedAt: hoursAgo(47) });
    const result = shouldAutoFail(cred, "OfferSent", Date.now());
    expect(result.fail).toBe(false);
  });

  it("flags OfferSent exactly at 48h", () => {
    const cred = baseCred({ issuedAt: hoursAgo(48) });
    const result = shouldAutoFail(cred, "OfferSent", Date.now());
    expect(result.fail).toBe(true);
    expect(result.reason).toMatch(/48h/);
  });

  it("flags OfferPending after 48h", () => {
    const cred = baseCred({ issuedAt: hoursAgo(72) });
    const result = shouldAutoFail(cred, "OfferPending", Date.now());
    expect(result.fail).toBe(true);
    expect(result.reason).toMatch(/72h/);
  });

  it("does NOT flag CredentialSent", () => {
    const cred = baseCred({ issuedAt: hoursAgo(100) });
    const result = shouldAutoFail(cred, "CredentialSent", Date.now());
    expect(result.fail).toBe(false);
  });

  it("does NOT flag RequestReceived", () => {
    const cred = baseCred({ issuedAt: hoursAgo(50) });
    const result = shouldAutoFail(cred, "RequestReceived", Date.now());
    expect(result.fail).toBe(false);
  });
});

describe("delivery sweep — shouldAutoConfirmRevocation", () => {
  it("returns false when no revocationPendingAt", () => {
    expect(shouldAutoConfirmRevocation(baseCred(), Date.now())).toBe(false);
  });

  it("returns false when already revoked", () => {
    const cred = baseCred({ revocationPendingAt: hoursAgo(200), revoked: true });
    expect(shouldAutoConfirmRevocation(cred, Date.now())).toBe(false);
  });

  it("returns false when pending < 7 days", () => {
    const cred = baseCred({ revocationPendingAt: hoursAgo(167) }); // 6d 23h
    expect(shouldAutoConfirmRevocation(cred, Date.now())).toBe(false);
  });

  it("returns true when pending >= 7 days", () => {
    const cred = baseCred({ revocationPendingAt: hoursAgo(168) }); // exactly 7d
    expect(shouldAutoConfirmRevocation(cred, Date.now())).toBe(true);
  });

  it("returns true when pending > 7 days", () => {
    const cred = baseCred({ revocationPendingAt: hoursAgo(200) });
    expect(shouldAutoConfirmRevocation(cred, Date.now())).toBe(true);
  });
});

describe("delivery sweep — shouldSkipDeliveryCheck", () => {
  it("returns false when never checked", () => {
    expect(shouldSkipDeliveryCheck(baseCred(), Date.now())).toBe(false);
  });

  it("returns true when checked less than 25 min ago", () => {
    const cred = baseCred({ deliveryCheckedAt: minutesAgo(10) });
    expect(shouldSkipDeliveryCheck(cred, Date.now())).toBe(true);
  });

  it("returns false when checked more than 25 min ago", () => {
    const cred = baseCred({ deliveryCheckedAt: minutesAgo(26) });
    expect(shouldSkipDeliveryCheck(cred, Date.now())).toBe(false);
  });
});

describe("delivery sweep — stuck credential detection for re-issue", () => {
  it("identifies credentials eligible for re-issue", () => {
    const candidates: IssuedCredential[] = [
      // ✓ Eligible: stuck OfferSent with issuingDid+schemaId, not failed
      baseCred({ deliveryState: "OfferSent", issuingDid: "did:prism:abc", schemaId: "http://schema/v1" }),
      // ✗ No issuingDid
      baseCred({ credentialRecordId: "rec-2", deliveryState: "OfferSent" }),
      // ✗ Already failed
      baseCred({ credentialRecordId: "rec-3", deliveryState: "OfferSent", issuingDid: "did:prism:abc", schemaId: "http://schema/v1", failedAt: new Date().toISOString() }),
      // ✗ CredentialSent (already delivered)
      baseCred({ credentialRecordId: "rec-4", deliveryState: "CredentialSent", issuingDid: "did:prism:abc", schemaId: "http://schema/v1" }),
      // ✓ Eligible: OfferPending
      baseCred({ credentialRecordId: "rec-5", deliveryState: "OfferPending", issuingDid: "did:prism:abc", schemaId: "http://schema/v1" }),
    ];

    const eligible = candidates.filter(
      (c) =>
        !c.revoked &&
        !c.failedAt &&
        (c.deliveryState === "OfferSent" || c.deliveryState === "OfferPending") &&
        c.issuingDid &&
        c.schemaId
    );

    expect(eligible).toHaveLength(2);
    expect(eligible.map((c) => c.credentialRecordId)).toEqual(["rec-1", "rec-5"]);
  });
});
