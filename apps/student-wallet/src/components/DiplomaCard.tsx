import { useState } from "react";
import type { CSSProperties } from "react";
import SDK from "@hyperledger/identus-edge-agent-sdk";
import type { DiplomaCredentialSubject } from "@university-diplomas/common";

interface DiplomaCardProps {
  credential: SDK.Domain.Credential;
  compact?: boolean;
  revoked?: boolean;
  revocationReason?: string;
  revocationDate?: string;
  cardanoscanUrl?: string;
  cardanoRevocationUrl?: string;
}

function extractClaims(credential: SDK.Domain.Credential): DiplomaCredentialSubject | null {
  try {
    const c = credential as unknown as Record<string, unknown>;

    let raw =
      c["claims"] ??
      c["credentialSubject"] ??
      (c["vc"] as Record<string, unknown> | undefined)?.["credentialSubject"] ??
      (c["payload"] as Record<string, unknown> | undefined)?.["vc"]?.["credentialSubject" as never];

    if (!raw) return null;

    // Array case: could be [{name, value}...] OR [credentialSubjectObject]
    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      const first = raw[0] as Record<string, unknown>;
      // If first element has a "name" key it's a {name,value} array — convert to object
      if (first && typeof first === "object" && "name" in first && "value" in first) {
        const obj: Record<string, unknown> = {};
        for (const claim of raw as Array<{ name: string; value: unknown }>) {
          if (claim?.name) obj[claim.name] = claim.value;
        }
        raw = obj;
      } else {
        // First element IS the credentialSubject object
        raw = first;
      }
    }

    return raw as DiplomaCredentialSubject;
  } catch (e) {
    console.error("[DiplomaCard] extractClaims error:", e);
    return null;
  }
}

function CertificateModal({ claims, cardanoscanUrl, onClose }: { claims: DiplomaCredentialSubject; cardanoscanUrl?: string; onClose: () => void }) {
  const overlay: CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000, padding: "1rem",
  };
  const cert: CSSProperties = {
    background: "#fffdf5",
    border: "12px solid #c9a84c",
    borderRadius: "4px",
    boxShadow: "0 0 0 4px #0f3460, 0 20px 60px rgba(0,0,0,0.4)",
    padding: "3rem 3.5rem",
    maxWidth: "640px",
    width: "100%",
    position: "relative",
    textAlign: "center",
    fontFamily: "Georgia, serif",
  };
  const corner: CSSProperties = {
    position: "absolute", width: "48px", height: "48px",
    border: "3px solid #c9a84c",
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={cert} onClick={(e) => e.stopPropagation()}>
        {/* Corner decorations */}
        <div style={{ ...corner, top: 8, left: 8, borderRight: "none", borderBottom: "none" }} />
        <div style={{ ...corner, top: 8, right: 8, borderLeft: "none", borderBottom: "none" }} />
        <div style={{ ...corner, bottom: 8, left: 8, borderRight: "none", borderTop: "none" }} />
        <div style={{ ...corner, bottom: 8, right: 8, borderLeft: "none", borderTop: "none" }} />

        {/* Seal */}
        <div style={{ fontSize: "3rem", marginBottom: "0.25rem" }}>🎓</div>

        {/* University */}
        <div style={{ fontSize: "0.8rem", letterSpacing: "0.2em", color: "#0f3460", textTransform: "uppercase", fontFamily: "sans-serif", fontWeight: 700, marginBottom: "0.5rem" }}>
          {claims.universityName}
        </div>

        {/* Divider */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.75rem 0" }}>
          <div style={{ flex: 1, height: "1px", background: "#c9a84c" }} />
          <div style={{ color: "#c9a84c", fontSize: "1rem" }}>✦</div>
          <div style={{ flex: 1, height: "1px", background: "#c9a84c" }} />
        </div>

        <div style={{ fontSize: "0.8rem", color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.5rem" }}>
          This certifies that
        </div>

        <div style={{ fontSize: "2rem", fontStyle: "italic", color: "#0f3460", margin: "0.5rem 0 1rem" }}>
          {claims.studentName}
        </div>

        <div style={{ fontSize: "0.85rem", color: "#475569", marginBottom: "0.25rem" }}>
          has successfully completed the requirements for the degree of
        </div>

        <div style={{ fontSize: "1.35rem", fontWeight: 700, color: "#1e293b", margin: "0.75rem 0", lineHeight: 1.3 }}>
          {claims.degree}
        </div>

        {/* Divider */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "1rem 0" }}>
          <div style={{ flex: 1, height: "1px", background: "#c9a84c" }} />
          <div style={{ color: "#c9a84c", fontSize: "1rem" }}>✦</div>
          <div style={{ flex: 1, height: "1px", background: "#c9a84c" }} />
        </div>

        {/* Details grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem 1.5rem", fontSize: "0.8rem", textAlign: "left", margin: "0 auto", maxWidth: "380px" }}>
          <div>
            <div style={{ color: "#94a3b8", fontFamily: "sans-serif", fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>Student ID</div>
            <div style={{ fontWeight: 600, color: "#1e293b", fontFamily: "sans-serif" }}>{claims.studentId}</div>
          </div>
          <div>
            <div style={{ color: "#94a3b8", fontFamily: "sans-serif", fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>Graduation Date</div>
            <div style={{ fontWeight: 600, color: "#1e293b", fontFamily: "sans-serif" }}>{claims.graduationDate}</div>
          </div>
          {claims.gpa !== undefined && (
            <div>
              <div style={{ color: "#94a3b8", fontFamily: "sans-serif", fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>GPA</div>
              <div style={{ fontWeight: 600, color: "#1e293b", fontFamily: "sans-serif" }}>{claims.gpa} / 4.0</div>
            </div>
          )}
          <div>
            <div style={{ color: "#94a3b8", fontFamily: "sans-serif", fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>Credential</div>
            <div style={{ fontWeight: 600, color: "#16a34a", fontFamily: "sans-serif", display: "flex", alignItems: "center", gap: "4px" }}>
              <span>✓</span> Verified on-chain
            </div>
          </div>
        </div>

        {/* Blockchain anchor link */}
        {cardanoscanUrl && (
          <div style={{ marginTop: "1.25rem", padding: "0.6rem 1rem", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "6px", display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "0.7rem", fontFamily: "sans-serif", color: "#1d4ed8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>⛓ Blockchain Anchor</span>
            <a
              href={cardanoscanUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: "0.75rem", color: "#1d4ed8", fontFamily: "sans-serif", fontWeight: 600 }}
            >
              View on Cardanoscan ↗
            </a>
          </div>
        )}

        {/* Issuer DID */}
        {claims.universityDid && (
          <div style={{ marginTop: "1.25rem", fontSize: "0.65rem", color: "#94a3b8", fontFamily: "monospace", wordBreak: "break-all" }}>
            Issued by: {claims.universityDid}
          </div>
        )}

        <button
          onClick={onClose}
          style={{ marginTop: "1.5rem", padding: "8px 24px", background: "#0f3460", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontFamily: "sans-serif", fontWeight: 600, fontSize: "0.85rem" }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function DiplomaCard({ credential, compact = false, revoked = false, revocationReason, revocationDate, cardanoscanUrl, cardanoRevocationUrl }: DiplomaCardProps) {
  const [showModal, setShowModal] = useState(false);
  const claims = extractClaims(credential);

  const cardStyle: CSSProperties = {
    background: compact ? "transparent" : revoked ? "#fff5f5" : "#fff",
    border: compact ? "none" : revoked ? "1px solid #fca5a5" : "1px solid #e2e8f0",
    borderRadius: "8px",
    padding: compact ? "0.75rem 1rem" : "1.5rem",
    marginBottom: compact ? 0 : "1rem",
    cursor: compact ? "default" : "pointer",
    transition: "box-shadow 0.15s, border-color 0.15s",
    position: "relative",
    opacity: revoked ? 0.75 : 1,
  };

  if (!claims) {
    return (
      <div style={cardStyle}>
        <span style={{ color: "#94a3b8", fontSize: "0.875rem" }}>Unknown credential format</span>
      </div>
    );
  }

  return (
    <>
      <div
        style={cardStyle}
        onClick={() => !compact && !revoked && setShowModal(true)}
        onMouseEnter={(e) => { if (!compact && !revoked) { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 16px rgba(0,0,0,0.1)"; (e.currentTarget as HTMLDivElement).style.borderColor = "#c9a84c"; } }}
        onMouseLeave={(e) => { if (!compact && !revoked) { (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; (e.currentTarget as HTMLDivElement).style.borderColor = "#e2e8f0"; } }}
      >
        {!compact && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
            {revoked ? (
              <span style={{ background: "#fee2e2", color: "#dc2626", borderRadius: "999px", padding: "2px 10px", fontSize: "0.75rem", fontWeight: 600 }}>
                ✕ Revoked
              </span>
            ) : (
              <span style={{ background: "#dbeafe", color: "#1d4ed8", borderRadius: "999px", padding: "2px 10px", fontSize: "0.75rem", fontWeight: 600 }}>
                ✓ Verified Diploma
              </span>
            )}
            {!revoked && <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Click to view certificate</span>}
          </div>
        )}
        {revoked && revocationReason && !compact && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", padding: "8px 12px", marginBottom: "0.75rem", fontSize: "0.8rem" }}>
            <span style={{ color: "#991b1b", fontWeight: 600 }}>Reason: </span>
            <span style={{ color: "#7f1d1d" }}>{revocationReason}</span>
            {revocationDate && (
              <span style={{ color: "#94a3b8", marginLeft: "8px", fontSize: "0.75rem" }}>
                — {new Date(revocationDate).toLocaleDateString()}
              </span>
            )}
          </div>
        )}
        <div style={{ fontWeight: 700, fontSize: compact ? "0.9rem" : "1.1rem" }}>
          {claims.degree ?? "Diploma"}
        </div>
        <div style={{ color: "#64748b", fontSize: "0.85rem", marginTop: "2px" }}>
          {claims.universityName ?? "University"}
        </div>
        {!compact && (
          <div style={{ marginTop: "0.75rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", fontSize: "0.8rem" }}>
            <div><span style={{ color: "#94a3b8" }}>Student: </span>{claims.studentName}</div>
            <div><span style={{ color: "#94a3b8" }}>ID: </span>{claims.studentId}</div>
            <div><span style={{ color: "#94a3b8" }}>Graduated: </span>{claims.graduationDate}</div>
            {claims.gpa !== undefined && (
              <div><span style={{ color: "#94a3b8" }}>GPA: </span>{claims.gpa}</div>
            )}
          </div>
        )}
        {!compact && !revoked && cardanoscanUrl && (
          <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid #e2e8f0" }}>
            <a
              href={cardanoscanUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.78rem", color: "#1d4ed8", fontWeight: 600, textDecoration: "none" }}
            >
              ⛓ On-chain anchor ↗
            </a>
          </div>
        )}
        {!compact && revoked && (cardanoscanUrl || cardanoRevocationUrl) && (
          <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid #fecaca", display: "flex", flexDirection: "column", gap: "4px" }}>
            {cardanoscanUrl && (
              <a
                href={cardanoscanUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.78rem", color: "#1d4ed8", fontWeight: 600, textDecoration: "none" }}
              >
                ⛓ Issuance anchor ↗
              </a>
            )}
            {cardanoRevocationUrl && (
              <a
                href={cardanoRevocationUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.78rem", color: "#dc2626", fontWeight: 600, textDecoration: "none" }}
              >
                ⛓ Revocation on-chain ↗
              </a>
            )}
          </div>
        )}
      </div>

      {showModal && <CertificateModal claims={claims} cardanoscanUrl={cardanoscanUrl} onClose={() => setShowModal(false)} />}
    </>
  );
}
