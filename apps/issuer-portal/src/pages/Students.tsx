import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  fetchStudents,
  createCredentialOffer,
  pollCredentialRecord,
  writeVcHashToCardano,
  listManagedDids,
  listSchemas,
  queueDiploma,
  fetchIssuedCredentials,
  revokeCredential,
  saveIssuedCredential,
  type RegisteredStudent,
  type IssuedCredential,
} from "../services/agentApi.js";

// -- Helpers ------------------------------------------------------------------

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS: [string, string][] = [
  ["#dbeafe", "#1d4ed8"],
  ["#dcfce7", "#15803d"],
  ["#fef9c3", "#a16207"],
  ["#fce7f3", "#9d174d"],
  ["#ede9fe", "#5b21b6"],
  ["#ffedd5", "#c2410c"],
  ["#e0f2fe", "#0369a1"],
  ["#f0fdf4", "#166534"],
];

function avatarColor(name: string): [string, string] {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// -- Style constants ----------------------------------------------------------

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  fontSize: "0.95rem",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  display: "block",
  marginBottom: "4px",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "#374151",
};

const btn = (variant: "primary" | "secondary" | "danger" | "ghost"): CSSProperties => {
  const base: CSSProperties = { padding: "7px 16px", borderRadius: "7px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "0.82rem", transition: "opacity 0.1s" };
  if (variant === "primary")   return { ...base, background: "#0f3460", color: "#fff" };
  if (variant === "secondary") return { ...base, background: "#f1f5f9", color: "#334155", border: "1px solid #e2e8f0" };
  if (variant === "danger")    return { ...base, background: "#dc2626", color: "#fff" };
  return { ...base, background: "none", border: "1px solid #e2e8f0", color: "#64748b" };
};

// -- Constants ----------------------------------------------------------------

const DEGREE_OPTIONS = [
  "Bachelor of Science in Computer Science",
  "Bachelor of Science in Mathematics",
  "Bachelor of Arts in Economics",
  "Master of Science in Data Science",
  "Master of Business Administration",
  "Doctor of Philosophy in Engineering",
];

// -- Connection badge ---------------------------------------------------------

function ConnectionBadge({ connectionId }: { connectionId?: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "5px",
      padding: "3px 10px", borderRadius: "999px", fontSize: "0.76rem", fontWeight: 600,
      background: connectionId ? "#dcfce7" : "#fef3c7",
      color: connectionId ? "#15803d" : "#b45309",
    }}>
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: connectionId ? "#16a34a" : "#f59e0b", display: "inline-block", flexShrink: 0 }} />
      {connectionId ? "Wallet linked" : "Not linked"}
    </span>
  );
}

// -- Issue Diploma Modal ------------------------------------------------------

type ModalStep = "form" | "issuing" | "success" | "error";

interface IssueModalProps {
  student: RegisteredStudent;
  issuingDid: string;
  schemaId: string;
  onClose: () => void;
}

function IssueModal({ student, issuingDid, schemaId, onClose }: IssueModalProps) {
  const [degree, setDegree] = useState(DEGREE_OPTIONS[0]);
  const [graduationDate, setGraduationDate] = useState("");
  const [gpa, setGpa] = useState("");
  const [step, setStep] = useState<ModalStep>("form");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");
  const [queuedFallback, setQueuedFallback] = useState(false);
  const [offerSentOnly, setOfferSentOnly] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const isConnected = !!student.connectionId;

  const handleSubmit = async () => {
    if (!graduationDate) { setError("Graduation date is required."); return; }
    if (!issuingDid) { setError("No published DID found. Run scripts/01-init-university-did.sh first."); return; }
    if (!schemaId) { setError("No diploma schema found. Run scripts/02-register-diploma-schema.sh first."); return; }

    setError("");
    const gpaNum = gpa ? parseFloat(gpa) : undefined;

    if (!isConnected) {
      setStep("issuing");
      setStatusMsg("Saving diploma to queue\u2026");
      try {
        await queueDiploma(student.id, { studentName: student.name, studentIdField: student.studentNumber || student.id, degree, graduationDate, gpa: gpaNum, issuingDid, schemaId });
        setStep("success");
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStep("error"); }
      return;
    }

    setStep("issuing");
    try {
      setStatusMsg("Creating credential offer\u2026");
      let record;
      try {
        record = await createCredentialOffer({ studentName: student.name, studentId: student.studentNumber || student.id, degree, graduationDate, gpa: gpaNum, connectionId: student.connectionId!, issuingDid, schemaId });
      } catch {
        setStatusMsg("Connection stale \u2014 queuing diploma for auto-delivery\u2026");
        await queueDiploma(student.id, { studentName: student.name, studentIdField: student.studentNumber || student.id, degree, graduationDate, gpa: gpaNum, issuingDid, schemaId });
        setQueuedFallback(true);
        setStep("success");
        return;
      }

      try {
        await saveIssuedCredential(student.id, { credentialRecordId: record.recordId, degree, graduationDate, ...(gpaNum !== undefined ? { gpa: gpaNum } : {}) });
      } catch { /* non-fatal */ }

      setStatusMsg("Offer sent \u2014 waiting for student wallet to accept\u2026");
      try {
        const finalRecord = await pollCredentialRecord(record.recordId);
        setStatusMsg("Writing VC hash to Cardano\u2026");
        try { await writeVcHashToCardano(finalRecord); } catch { /* non-fatal */ }
      } catch { setOfferSentOnly(true); }

      setStep("success");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStep("error"); }
  };

  const [abg, afg] = avatarColor(student.name);

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "1rem" }}
    >
      <div style={{ background: "#fff", borderRadius: "14px", width: "min(520px, 100%)", boxShadow: "0 24px 64px rgba(0,0,0,0.3)", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ background: "#0f3460", borderRadius: "14px 14px 0 0", padding: "1.25rem 1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ width: "38px", height: "38px", borderRadius: "50%", background: abg, color: afg, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "0.9rem", flexShrink: 0 }}>
              {initials(student.name)}
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(255,255,255,0.6)", marginBottom: "2px" }}>Issue Diploma</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "#fff" }}>{student.name}</div>
              <div style={{ fontSize: "0.78rem", color: "rgba(255,255,255,0.7)" }}>{student.email}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1 }}>&times;</button>
        </div>

        <div style={{ padding: "1.5rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.25rem" }}>
            <div><label style={labelStyle}>Student Name</label><input style={{ ...inputStyle, background: "#f8fafc", color: "#64748b" }} value={student.name} readOnly /></div>
            <div><label style={labelStyle}>Student ID</label><input style={{ ...inputStyle, background: "#f8fafc", color: "#64748b" }} value={student.studentNumber || student.id} readOnly /></div>
          </div>

          {(step === "form" || step === "error") && (
            <>
              <div style={{ display: "grid", gap: "1rem" }}>
                <div>
                  <label style={labelStyle}>Degree *</label>
                  <select style={inputStyle} value={degree} onChange={(e) => setDegree(e.target.value)}>
                    {DEGREE_OPTIONS.map((d) => <option key={d}>{d}</option>)}
                  </select>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                  <div>
                    <label style={labelStyle}>Graduation Date *</label>
                    <input style={inputStyle} type="date" value={graduationDate} onChange={(e) => setGraduationDate(e.target.value)} />
                  </div>
                  <div>
                    <label style={labelStyle}>GPA <span style={{ fontWeight: 400, color: "#94a3b8" }}>(optional, 0&ndash;4.0)</span></label>
                    <input style={inputStyle} type="number" step="0.01" min="0" max="4" value={gpa} onChange={(e) => setGpa(e.target.value)} placeholder="3.85" />
                  </div>
                </div>
              </div>

              {!isConnected && (
                <div style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "#1e40af", background: "#eff6ff", padding: "10px 14px", borderRadius: "8px", border: "1px solid #bfdbfe" }}>
                  📬 Wallet not yet linked &mdash; diploma will be <strong>queued</strong> and auto-delivered when they open their wallet.
                </div>
              )}
              {error && <div style={{ marginTop: "0.75rem", color: "#dc2626", fontSize: "0.875rem", background: "#fef2f2", padding: "10px 14px", borderRadius: "8px", border: "1px solid #fecaca" }}>{error}</div>}

              <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                <button style={btn("secondary")} onClick={onClose}>Cancel</button>
                <button style={btn("primary")} onClick={handleSubmit}>
                  {isConnected ? "Issue Diploma \u2713" : "Queue Diploma \uD83D\uDCEC"}
                </button>
              </div>
            </>
          )}

          {step === "issuing" && (
            <div style={{ textAlign: "center", padding: "2.5rem 0" }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>{"\u23F3"}</div>
              <p style={{ color: "#64748b", fontSize: "0.9rem", margin: 0 }}>{statusMsg}</p>
            </div>
          )}

          {step === "success" && (
            <div style={{ textAlign: "center", padding: "1.5rem 0" }}>
              <div style={{ fontSize: "3rem", marginBottom: "0.75rem" }}>{isConnected && !queuedFallback && !offerSentOnly ? "\uD83C\uDF93" : "\uD83D\uDCEC"}</div>
              <h3 style={{ color: "#15803d", margin: "0 0 0.5rem", fontSize: "1.1rem" }}>
                {isConnected && !queuedFallback && !offerSentOnly ? "Diploma Issued!" : "Diploma Queued!"}
              </h3>
              <p style={{ color: "#64748b", fontSize: "0.875rem", margin: "0 0 1.25rem" }}>
                {queuedFallback
                  ? `Connection was stale \u2014 diploma queued for ${student.name}. It will be auto-delivered when they reconnect.`
                  : offerSentOnly
                  ? `Offer sent to ${student.name}'s wallet. It will be stored when they next open it.`
                  : isConnected
                  ? `The diploma has been delivered to ${student.name}'s wallet.`
                  : `Queued \u2014 it will be auto-delivered when ${student.name} opens their wallet.`}
              </p>
              <div style={{ textAlign: "left", background: "#f8fafc", borderRadius: "8px", padding: "0.875rem 1.1rem", marginBottom: "1.25rem", fontSize: "0.875rem", border: "1px solid #e2e8f0" }}>
                <div style={{ marginBottom: "4px" }}><strong>Degree:</strong> {degree}</div>
                <div style={{ marginBottom: "4px" }}><strong>Graduation:</strong> {graduationDate}</div>
                {gpa && <div><strong>GPA:</strong> {gpa}</div>}
              </div>
              <button style={{ ...btn("primary"), width: "100%", padding: "10px" }} onClick={onClose}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Credentials Panel (full modal) -------------------------------------------

function CredentialsPanel({ student, onClose }: { student: RegisteredStudent; onClose: () => void }) {
  const [creds, setCreds] = useState<IssuedCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<IssuedCredential | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const pollingRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const load = useCallback(() => {
    setLoading(true);
    fetchIssuedCredentials(student.id)
      .then(setCreds)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [student.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { return () => { pollingRefs.current.forEach((h) => clearInterval(h)); }; }, []);

  function startPolling(recordId: string) {
    if (pollingRefs.current.has(recordId)) return;
    const handle = setInterval(async () => {
      try {
        const updated = await fetchIssuedCredentials(student.id);
        const cred = updated.find((c) => c.credentialRecordId === recordId);
        if (cred?.revoked) {
          setCreds(updated);
          clearInterval(pollingRefs.current.get(recordId));
          pollingRefs.current.delete(recordId);
          setRevoking((prev) => (prev === recordId ? null : prev));
        }
      } catch { /* ignore poll errors */ }
    }, 3_000);
    pollingRefs.current.set(recordId, handle);
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    const cred = revokeTarget;
    setRevokeTarget(null);
    const reason = revokeReason.trim();
    setRevokeReason("");
    setRevoking(cred.credentialRecordId);
    try {
      await revokeCredential(student.id, cred.credentialRecordId, reason || undefined);
      setCreds((prev) =>
        prev.map((c) =>
          c.credentialRecordId === cred.credentialRecordId
            ? { ...c, revocationPendingAt: new Date().toISOString(), revocationReason: reason || undefined }
            : c
        )
      );
      startPolling(cred.credentialRecordId);
    } catch (e: unknown) {
      alert(`Revocation failed: ${e instanceof Error ? e.message : String(e)}`);
      setRevoking(null);
    }
  }

  function credStatus(c: IssuedCredential) {
    if (c.revoked) return "revoked" as const;
    if (c.revocationPendingAt) return "revoking" as const;
    return "active" as const;
  }

  const [abg, afg] = avatarColor(student.name);

  return createPortal(
    <>
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "1rem" }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{ background: "#fff", borderRadius: "14px", width: "min(640px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.3)" }}>
          {/* Header */}
          <div style={{ background: "#0f3460", borderRadius: "14px 14px 0 0", padding: "1.25rem 1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ width: "38px", height: "38px", borderRadius: "50%", background: abg, color: afg, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "0.9rem", flexShrink: 0 }}>
                {initials(student.name)}
              </div>
              <div>
                <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(255,255,255,0.6)", marginBottom: "2px" }}>Issued Credentials</div>
                <div style={{ fontSize: "1rem", fontWeight: 700, color: "#fff" }}>{student.name}</div>
                <div style={{ fontSize: "0.78rem", color: "rgba(255,255,255,0.7)" }}>{student.email}</div>
              </div>
            </div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1 }}>&times;</button>
          </div>

          {/* Body */}
          <div style={{ padding: "1.25rem 1.5rem", overflowY: "auto", flex: 1 }}>
            {loading && <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>Loading credentials&hellip;</div>}
            {error && <div style={{ padding: "1rem", background: "#fef2f2", borderRadius: "8px", color: "#dc2626", fontSize: "0.875rem" }}>{error}</div>}
            {!loading && !error && creds.length === 0 && (
              <div style={{ textAlign: "center", padding: "2.5rem", color: "#cbd5e1" }}>
                <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>{"\uD83C\uDF93"}</div>
                No credentials issued to this student yet.
              </div>
            )}

            {creds.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {[...creds].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime()).map((c) => {
                  const status = credStatus(c);
                  const cfg = {
                    active:   { bg: "#f0fdf4", border: "#86efac", color: "#15803d", label: "Active",         icon: "\u2713"  },
                    revoking: { bg: "#fffbeb", border: "#fcd34d", color: "#d97706", label: "Revoking\u2026", icon: "\u23F3" },
                    revoked:  { bg: "#fef2f2", border: "#fca5a5", color: "#dc2626", label: "Revoked",        icon: "\u2715"  },
                  }[status];
                  return (
                    <div key={c.credentialRecordId} style={{ border: `1px solid ${cfg.border}`, borderLeft: `4px solid ${cfg.color}`, background: cfg.bg, borderRadius: "10px", padding: "1rem 1.25rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, color: "#0f1c33", fontSize: "0.9rem", marginBottom: "4px", lineHeight: 1.3 }}>{c.degree}</div>
                          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.8rem", color: "#64748b" }}>
                            <span>{"\uD83C\uDF93"} Graduated {c.graduationDate}</span>
                            <span>{"\uD83D\uDCC5"} Issued {new Date(c.issuedAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</span>
                            {c.gpa != null && <span>GPA {c.gpa}</span>}
                          </div>
                          {c.revocationReason && (
                            <div style={{ marginTop: "6px", fontSize: "0.8rem", color: "#dc2626", fontStyle: "italic" }}>Reason: {c.revocationReason}</div>
                          )}
                          {c.revocationConfirmedAt && (
                            <div style={{ marginTop: "3px", fontSize: "0.75rem", color: "#94a3b8" }}>Confirmed {new Date(c.revocationConfirmedAt).toLocaleString()}</div>
                          )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px", flexShrink: 0 }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", background: "#fff", border: `1px solid ${cfg.color}55`, color: cfg.color, borderRadius: "999px", padding: "2px 10px", fontSize: "0.73rem", fontWeight: 700, whiteSpace: "nowrap" }}>
                            {cfg.icon} {cfg.label}
                          </span>
                          {status === "active" && (
                            <button
                              onClick={() => { setRevokeTarget(c); setRevokeReason(""); }}
                              disabled={revoking === c.credentialRecordId}
                              style={{ padding: "4px 12px", borderRadius: "6px", border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", cursor: "pointer", fontSize: "0.78rem", fontWeight: 600 }}
                            >
                              Revoke
                            </button>
                          )}
                          {status === "revoking" && (
                            <span style={{ fontSize: "0.73rem", color: "#94a3b8", whiteSpace: "nowrap" }}>Awaiting wallet&hellip;</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Revoke reason modal */}
      {revokeTarget && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: "1rem" }}
          onClick={(e) => { if (e.target === e.currentTarget) setRevokeTarget(null); }}
        >
          <div style={{ background: "#fff", borderRadius: "12px", padding: "1.5rem", width: "min(480px, 100%)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
            <h3 style={{ margin: "0 0 0.25rem", fontSize: "1.1rem", color: "#0f3460" }}>Revoke Credential</h3>
            <p style={{ margin: "0 0 1rem", fontSize: "0.85rem", color: "#64748b" }}>
              <strong>{revokeTarget.degree}</strong> &mdash; {revokeTarget.graduationDate}
            </p>
            <p style={{ margin: "0 0 0.5rem", fontSize: "0.875rem", color: "#334155", fontWeight: 600 }}>
              Reason <span style={{ color: "#94a3b8", fontWeight: 400 }}>(required)</span>
            </p>
            <textarea
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder="e.g. Student withdrew from programme, Diploma issued in error&hellip;"
              rows={3}
              style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: "6px", fontSize: "0.875rem", resize: "vertical", fontFamily: "inherit" }}
            />
            <p style={{ margin: "0.6rem 0 1rem", fontSize: "0.78rem", color: "#94a3b8" }}>
              The status bit is flipped immediately. This portal will show <em>Revoked</em> once the student&apos;s wallet acknowledges.
            </p>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button onClick={() => setRevokeTarget(null)} style={btn("secondary")}>Cancel</button>
              <button
                onClick={handleRevoke}
                disabled={!revokeReason.trim()}
                style={{ ...btn("danger"), opacity: revokeReason.trim() ? 1 : 0.45, cursor: revokeReason.trim() ? "pointer" : "not-allowed" }}
              >
                Revoke Credential
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}

// -- Student row --------------------------------------------------------------

interface StudentRowProps {
  student: RegisteredStudent;
  avatarBg: string;
  avatarFg: string;
  credCount: number;
  onIssue: () => void;
  onCreds: () => void;
}

function StudentRow({ student: s, avatarBg, avatarFg, credCount, onIssue, onCreds }: StudentRowProps) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      style={{ borderBottom: "1px solid #f1f5f9", background: hover ? "#f8fafc" : "#fff", transition: "background 0.1s" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <td style={{ padding: "11px 16px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "34px", height: "34px", borderRadius: "50%", background: avatarBg, color: avatarFg, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "0.8rem", flexShrink: 0 }}>
            {initials(s.name)}
          </div>
          <div>
            <div style={{ fontWeight: 600, color: "#0f1c33", fontSize: "0.875rem" }}>{s.name}</div>
            <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{s.email}</div>
          </div>
        </div>
      </td>
      <td style={{ padding: "11px 16px", fontSize: "0.875rem", color: "#475569", verticalAlign: "middle" }}>
        {s.studentNumber || <span style={{ color: "#cbd5e1" }}>&mdash;</span>}
      </td>
      <td style={{ padding: "11px 16px", verticalAlign: "middle" }}>
        <ConnectionBadge connectionId={s.connectionId} />
      </td>
      <td style={{ padding: "11px 16px", verticalAlign: "middle", fontFamily: "monospace", fontSize: "0.75rem", color: "#64748b" }}>
        {s.walletDid ? (
          <span title={s.walletDid} onClick={() => navigator.clipboard.writeText(s.walletDid!)} style={{ cursor: "pointer", borderBottom: "1px dashed #94a3b8" }}>
            {s.walletDid.slice(0, 18)}&hellip;{s.walletDid.slice(-6)}
          </span>
        ) : <span style={{ color: "#cbd5e1" }}>&mdash;</span>}
      </td>
      <td style={{ padding: "11px 16px", fontSize: "0.8rem", color: "#94a3b8", whiteSpace: "nowrap", verticalAlign: "middle" }}>
        {new Date(s.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
      </td>
      <td style={{ padding: "11px 16px", whiteSpace: "nowrap", verticalAlign: "middle" }}>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button style={btn("primary")} onClick={onIssue}>Issue Diploma</button>
          <button style={{ ...btn("ghost"), display: "flex", alignItems: "center", gap: "5px" }} onClick={onCreds}>
            Credentials
            {credCount > 0 && (
              <span style={{ background: "#7c3aed20", color: "#7c3aed", borderRadius: "999px", padding: "1px 7px", fontSize: "0.7rem", fontWeight: 700 }}>
                {credCount}
              </span>
            )}
          </button>
        </div>
      </td>
    </tr>
  );
}

// -- Main page ----------------------------------------------------------------

export function Students() {
  const [students, setStudents] = useState<RegisteredStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [issuingDid, setIssuingDid] = useState(import.meta.env.VITE_UNIVERSITY_DID ?? "");
  const [schemaId, setSchemaId] = useState(import.meta.env.VITE_DIPLOMA_SCHEMA_ID ?? "");
  const [activeStudent, setActiveStudent] = useState<RegisteredStudent | null>(null);
  const [credStudent, setCredStudent] = useState<RegisteredStudent | null>(null);
  const [search, setSearch] = useState("");

  const load = () => {
    setLoading(true);
    fetchStudents()
      .then(setStudents)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const id = setInterval(() => { fetchStudents().then(setStudents).catch(() => {}); }, 8_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!issuingDid) {
      listManagedDids()
        .then((dids) => { const p = dids.find((d) => d.status === "PUBLISHED"); if (p) setIssuingDid(p.did); })
        .catch(() => {});
    }
    if (!schemaId) {
      listSchemas()
        .then((schemas) => {
          const d = schemas.find((s) => s.name === "DiplomaCredential");
          if (d) setSchemaId(`http://localhost:8085/schema-registry/schemas/${d.guid}`);
        })
        .catch(() => {});
    }
  }, [issuingDid, schemaId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.email.toLowerCase().includes(q) ||
      (s.studentNumber ?? "").toLowerCase().includes(q)
    );
  }, [students, search]);

  const stats = useMemo(() => ({
    total: students.length,
    connected: students.filter((s) => !!s.connectionId).length,
    credentials: students.reduce((sum, s) => sum + (s.issuedCredentials?.length ?? 0), 0),
  }), [students]);

  return (
    <>
      {/* Page header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.75rem", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 800, color: "#0f1c33" }}>Students</h1>
          <p style={{ margin: "4px 0 0", fontSize: "0.875rem", color: "#64748b" }}>
            Connected students receive diplomas instantly; others are queued for auto-delivery.
          </p>
        </div>
        <button
          onClick={load}
          style={{ padding: "7px 16px", borderRadius: "8px", border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: "0.82rem", fontWeight: 600, color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}
        >
          &#x21bb; Refresh
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.875rem", marginBottom: "1.75rem", maxWidth: "480px" }}>
        {[
          { label: "Total Students",     value: stats.total,       accent: "#0f3460" },
          { label: "Wallets Linked",      value: stats.connected,   accent: "#16a34a" },
          { label: "Credentials Issued",  value: stats.credentials, accent: "#7c3aed" },
        ].map(({ label, value, accent }) => (
          <div key={label} style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e2e8f0", borderTop: `3px solid ${accent}`, padding: "0.875rem 1.1rem" }}>
            <div style={{ fontSize: "1.75rem", fontWeight: 800, color: accent, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Search + table */}
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: "10px", overflow: "hidden" }}>
        <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #f1f5f9", display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email or student number&hellip;"
            style={{ flex: 1, padding: "7px 12px", border: "1px solid #e2e8f0", borderRadius: "7px", fontSize: "0.875rem", outline: "none", background: "#f8fafc" }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{ padding: "6px 12px", border: "1px solid #e2e8f0", borderRadius: "7px", background: "#fff", cursor: "pointer", fontSize: "0.8rem", color: "#64748b" }}>
              Clear
            </button>
          )}
        </div>

        {loading && <div style={{ padding: "3rem", textAlign: "center", color: "#94a3b8" }}>Loading students&hellip;</div>}
        {error && <div style={{ padding: "1.25rem", background: "#fef2f2", color: "#dc2626", fontSize: "0.875rem" }}>{error}</div>}

        {!loading && !error && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["Student", "Student #", "Wallet", "DID", "Registered", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "9px 16px", fontSize: "0.68rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: "3.5rem", color: "#cbd5e1" }}>
                      {students.length === 0
                        ? "No students registered yet. Students appear here after logging in to the wallet app."
                        : "No students match your search."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((s) => {
                    const [abg, afg] = avatarColor(s.name);
                    return (
                      <StudentRow
                        key={s.id}
                        student={s}
                        avatarBg={abg}
                        avatarFg={afg}
                        credCount={s.issuedCredentials?.length ?? 0}
                        onIssue={() => setActiveStudent(s)}
                        onCreds={() => setCredStudent(s)}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
            {filtered.length > 0 && (
              <div style={{ padding: "0.6rem 1rem", borderTop: "1px solid #f1f5f9", fontSize: "0.75rem", color: "#94a3b8" }}>
                Showing {filtered.length} of {students.length} students
              </div>
            )}
          </div>
        )}
      </div>

      {activeStudent && (
        <IssueModal student={activeStudent} issuingDid={issuingDid} schemaId={schemaId} onClose={() => setActiveStudent(null)} />
      )}
      {credStudent && (
        <CredentialsPanel student={credStudent} onClose={() => setCredStudent(null)} />
      )}
    </>
  );
}