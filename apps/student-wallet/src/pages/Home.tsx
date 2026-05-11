import { useState, useEffect, useCallback } from "react";
import type { CSSProperties } from "react";
import { useWalletContext } from "../context/WalletContext.js";
import { DiplomaCard } from "../components/DiplomaCard.js";
import { fetchStudentCredentials, confirmRevocation, type IssuedCredentialRecord } from "../services/authApi.js";

const statusColor: Record<string, string> = {
  idle: "#94a3b8",
  starting: "#f59e0b",
  connecting: "#3b82f6",
  ready: "#16a34a",
  error: "#dc2626",
};

const statusLabel: Record<string, string> = {
  idle: "Stopped",
  starting: "Starting wallet…",
  connecting: "Connecting to issuer…",
  ready: "Ready \u2713",
  error: "Error",
};

/** Extract degree + graduationDate from an SDK credential.
 *  Uses the same parsing logic as DiplomaCard.extractClaims to guarantee consistency. */
function extractClaimsForMatch(cred: unknown): { degree?: string; graduationDate?: string } {
  try {
    const c = cred as Record<string, unknown>;

    let raw: unknown =
      c["claims"] ??
      c["credentialSubject"] ??
      (c["vc"] as Record<string, unknown> | undefined)?.["credentialSubject"] ??
      (c["payload"] as Record<string, unknown> | undefined)?.["vc"]?.["credentialSubject" as never];

    if (!raw) return {};

    if (Array.isArray(raw)) {
      if (raw.length === 0) return {};
      const first = raw[0] as Record<string, unknown>;
      if (first && typeof first === "object" && "name" in first && "value" in first) {
        // [{name,value}…] format — convert to plain object
        const obj: Record<string, unknown> = {};
        for (const claim of raw as Array<{ name: string; value: unknown }>) {
          if (claim?.name) obj[claim.name] = claim.value;
        }
        raw = obj;
      } else {
        raw = first;
      }
    }

    const obj = raw as Record<string, unknown>;
    return {
      degree: obj["degree"] as string | undefined,
      graduationDate: obj["graduationDate"] as string | undefined,
    };
  } catch { return {}; }
}

export function Home() {
  const { status, credentials, error, connectionError, isConnecting, currentUser, token, walletDid, retryConnection } = useWalletContext();
  const [issuedRecords, setIssuedRecords] = useState<IssuedCredentialRecord[]>([]);
  const [tab, setTab] = useState<"active" | "revoked">("active");

  const refreshRecords = useCallback(async () => {
    if (!currentUser || !token) return;
    try {
      const records = await fetchStudentCredentials(currentUser.id, token);
      setIssuedRecords(records);

      // Auto-confirm any pending revocations so the issuer portal can see them confirmed
      const pendingUnconfirmed = records.filter(
        (r) => r.revocationPendingAt && !r.revocationConfirmedAt
      );
      for (const rec of pendingUnconfirmed) {
        await confirmRevocation(currentUser.id, rec.credentialRecordId, token);
      }
      // Refresh again if we confirmed anything to get updated revoked:true state
      if (pendingUnconfirmed.length > 0) {
        const updated = await fetchStudentCredentials(currentUser.id, token);
        setIssuedRecords(updated);
      }
    } catch { /* silently ignore */ }
  }, [currentUser, token]);

  // Poll every 10 s so the wallet picks up revocations even when it's already open.
  useEffect(() => {
    void refreshRecords();
    const id = setInterval(() => { void refreshRecords(); }, 10_000);
    return () => clearInterval(id);
  }, [refreshRecords]);

  // Deduplicate Pluto credentials by (degree, graduationDate).
  // Previous duplicate issuances can leave multiple copies in Pluto for the same
  // credential — keep only one per pair (the last one, i.e. the most recent).
  const seenKeys = new Set<string>();
  const deduped = [...credentials].reverse().filter((c) => {
    const { degree, graduationDate } = extractClaimsForMatch(c);
    if (!degree || !graduationDate) return true;
    const key = `${degree}||${graduationDate}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  }).reverse();

  // Build a set of (degree||graduationDate) pairs that are revoked/pending per server records.
  // A pair is only fully revoked if it has NO active server records — this handles the case
  // where a student has both a revoked and an active credential with the same degree+date
  // (common during testing / re-issuance), which should NOT hide the active credential.
  const activeServerPairs = new Set(
    issuedRecords
      .filter((r) => !r.revoked && !r.revocationPendingAt)
      .map((r) => `${r.degree}||${r.graduationDate}`)
  );
  const revokedByServer = new Set(
    issuedRecords
      .filter((r) => r.revoked || !!r.revocationPendingAt)
      .map((r) => `${r.degree}||${r.graduationDate}`)
      .filter((key) => !activeServerPairs.has(key))
  );

  const activeCreds = deduped.filter((c) => {
    const { degree, graduationDate } = extractClaimsForMatch(c);
    // If we can read the claims and the server says it's revoked → hide from active
    if (degree && graduationDate && revokedByServer.has(`${degree}||${graduationDate}`)) {
      return false;
    }
    // If we can't read claims at all, keep in active (don't hide unknown credentials)
    return true;
  });

  const revokedCreds = deduped.filter((c) => {
    const { degree, graduationDate } = extractClaimsForMatch(c);
    if (!degree || !graduationDate) return false;
    return revokedByServer.has(`${degree}||${graduationDate}`);
  });

  /** Returns the most recently revoked server record matching a given degree+graduationDate pair. */
  function findRevokedRecord(degree: string | undefined, graduationDate: string | undefined) {
    if (!degree || !graduationDate) return undefined;
    return issuedRecords
      .filter((r) => r.degree === degree && r.graduationDate === graduationDate && (r.revoked || !!r.revocationPendingAt))
      .sort((a, b) => new Date(b.revocationConfirmedAt ?? b.revocationPendingAt ?? 0).getTime() - new Date(a.revocationConfirmedAt ?? a.revocationPendingAt ?? 0).getTime())[0];
  }

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
        My Diplomas
      </h1>
      {currentUser && (
        <p style={{ color: "#64748b", fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          Welcome, <strong>{currentUser.name}</strong>
          {currentUser.studentNumber ? ` (${currentUser.studentNumber})` : ""}
        </p>
      )}

      {walletDid && (
        <p
          title={walletDid}
          onClick={() => navigator.clipboard.writeText(walletDid)}
          style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#64748b", marginBottom: "1.5rem", cursor: "pointer", borderBottom: "1px dashed #cbd5e1", display: "inline-block" }}
        >
          DID: {walletDid.slice(0, 28)}&hellip;{walletDid.slice(-10)}
        </p>
      )}

      {/* Wallet status pill */}
      <div style={pillContainerStyle}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 12px",
            borderRadius: "999px",
            background: "#f1f5f9",
            fontSize: "0.85rem",
            fontWeight: 600,
            color: statusColor[status] ?? "#64748b",
          }}
        >
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: statusColor[status] ?? "#64748b", display: "inline-block" }} />
          {statusLabel[status] ?? status}
        </span>
        {error && (
          <span style={{ marginLeft: "1rem", fontSize: "0.8rem", color: "#dc2626" }}>
            {error}
          </span>
        )}
      </div>

      {/* Issuer connection status */}
      {status === "ready" && (
        <div style={{ marginBottom: "1.5rem", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          {currentUser?.connectionId ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 10px", borderRadius: "999px", fontSize: "0.78rem", fontWeight: 600, background: "#dcfce7", color: "#15803d" }}>
              <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#16a34a", display: "inline-block" }} />
              Connected to issuer
            </span>
          ) : (
            <>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 10px", borderRadius: "999px", fontSize: "0.78rem", fontWeight: 600, background: "#fef3c7", color: "#b45309" }}>
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
                Not connected to issuer
              </span>
              <button
                onClick={retryConnection}
                disabled={isConnecting}
                style={{ padding: "3px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#fff", cursor: isConnecting ? "not-allowed" : "pointer", fontSize: "0.78rem", fontWeight: 600, opacity: isConnecting ? 0.6 : 1 }}
              >
                {isConnecting ? "Connecting…" : "Connect now"}
              </button>
              {connectionError && (
                <span style={{ fontSize: "0.75rem", color: "#dc2626" }}>
                  ⚠ {connectionError}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: "2px", marginBottom: "1.25rem", borderBottom: "2px solid #e2e8f0" }}>
        <button
          onClick={() => setTab("active")}
          style={{
            padding: "8px 20px", border: "none", background: "none", cursor: "pointer",
            fontSize: "0.875rem", fontWeight: 600,
            color: tab === "active" ? "#0f3460" : "#94a3b8",
            borderBottom: tab === "active" ? "2px solid #0f3460" : "2px solid transparent",
            marginBottom: "-2px",
          }}
        >
          Verified Diplomas
          {activeCreds.length > 0 && (
            <span style={{ marginLeft: "6px", background: "#dbeafe", color: "#1d4ed8", borderRadius: "999px", padding: "1px 7px", fontSize: "0.7rem" }}>
              {activeCreds.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("revoked")}
          style={{
            padding: "8px 20px", border: "none", background: "none", cursor: "pointer",
            fontSize: "0.875rem", fontWeight: 600,
            color: tab === "revoked" ? "#dc2626" : "#94a3b8",
            borderBottom: tab === "revoked" ? "2px solid #dc2626" : "2px solid transparent",
            marginBottom: "-2px",
          }}
        >
          Revoked
          {revokedCreds.length > 0 && (
            <span style={{ marginLeft: "6px", background: "#fee2e2", color: "#dc2626", borderRadius: "999px", padding: "1px 7px", fontSize: "0.7rem" }}>
              {revokedCreds.length}
            </span>
          )}
        </button>
      </div>

      {/* Active tab */}
      {tab === "active" && (
        <>
          {status === "ready" && activeCreds.length === 0 && (
            <div style={{ textAlign: "center", padding: "3rem", color: "#94a3b8" }}>
              No active diplomas yet. Your issuer will send you one when you&apos;re graduated.
            </div>
          )}
          {activeCreds.map((cred, i) => {
            const { degree, graduationDate } = extractClaimsForMatch(cred);
            const rec = issuedRecords.find((r) => r.degree === degree && r.graduationDate === graduationDate && !r.revoked && !r.revocationPendingAt);
            return <DiplomaCard key={i} credential={cred} cardanoscanUrl={rec?.cardanoscanUrl} />;
          })}
        </>
      )}

      {/* Revoked tab */}
      {tab === "revoked" && (
        <>
          {revokedCreds.length === 0 && (
            <div style={{ textAlign: "center", padding: "3rem", color: "#94a3b8" }}>
              No revoked diplomas.
            </div>
          )}
          {[...revokedCreds]
            .sort((a, b) => {
              const { degree: da, graduationDate: ga } = extractClaimsForMatch(a);
              const { degree: db, graduationDate: gb } = extractClaimsForMatch(b);
              const recA = findRevokedRecord(da, ga);
              const recB = findRevokedRecord(db, gb);
              const tA = new Date(recA?.revocationConfirmedAt ?? recA?.revocationPendingAt ?? 0).getTime();
              const tB = new Date(recB?.revocationConfirmedAt ?? recB?.revocationPendingAt ?? 0).getTime();
              return tB - tA;
            })
            .map((cred, i) => {
              const { degree, graduationDate } = extractClaimsForMatch(cred);
              const rec = findRevokedRecord(degree, graduationDate);
              return (
                <DiplomaCard
                  key={i}
                  credential={cred}
                  revoked
                  revocationReason={rec?.revocationReason}
                  revocationDate={rec?.revocationConfirmedAt ?? rec?.revocationPendingAt}
                  cardanoscanUrl={rec?.cardanoscanUrl}
                  cardanoRevocationUrl={rec?.cardanoRevocationUrl}
                />
              );
            })}
        </>
      )}
    </>
  );
}

const pillContainerStyle: CSSProperties = {
  marginBottom: "1.5rem",
  display: "flex",
  alignItems: "center",
};

