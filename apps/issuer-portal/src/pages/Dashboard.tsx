import { useState, useEffect, useMemo, type CSSProperties } from "react";
import { useDiplomas } from "../hooks/useDiplomas.js";
import { fetchStudents, type IssuedCredential } from "../services/agentApi.js";
import type { AgentCredentialRecord } from "@university-diplomas/common";

// -- Protocol state helpers --------------------------------------------------

const stateColor: Record<string, string> = {
  CredentialSent: "#16a34a",
  OfferSent: "#f59e0b",
  RequestSent: "#3b82f6",
  RequestReceived: "#3b82f6",
  RequestPending: "#a78bfa",
  CredentialPending: "#a78bfa",
  ProblemReportPending: "#ef4444",
};

const stateLabel: Record<string, string> = {
  CredentialSent: "Issued \u2713",
  OfferSent: "Offer Sent",
  RequestSent: "Request Sent",
  RequestReceived: "Request Received",
  RequestPending: "Pending",
  CredentialPending: "Preparing",
  ProblemReportPending: "Failed",
};

const IN_PROGRESS_STATES = new Set(["OfferSent", "RequestSent", "RequestReceived", "RequestPending", "CredentialPending"]);

function IssueBadge({ state }: { state: string }) {
  const color = stateColor[state] ?? "#94a3b8";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "4px",
      background: color + "18", color, border: `1px solid ${color + "55"}`,
      borderRadius: "999px", padding: "2px 10px", fontSize: "0.72rem", fontWeight: 700, whiteSpace: "nowrap",
    }}>
      {stateLabel[state] ?? state}
    </span>
  );
}

// -- Revocation helpers --------------------------------------------------------

type RevStatus = "active" | "revoking" | "revoked" | "unknown";

function getRevStatus(info?: IssuedCredential): RevStatus {
  if (!info) return "unknown";
  if (info.revoked) return "revoked";
  if (info.revocationPendingAt) return "revoking";
  return "active";
}

function RevBadge({ info }: { info?: IssuedCredential }) {
  const s = getRevStatus(info);
  if (s === "unknown") return <span style={{ color: "#cbd5e1", fontSize: "0.75rem" }}>{"-"}</span>;
  const map: Record<RevStatus, { label: string; color: string }> = {
    active:   { label: "Active",    color: "#16a34a" },
    revoking: { label: "\u23f3 Revoking", color: "#d97706" },
    revoked:  { label: "\u2715 Revoked",  color: "#dc2626" },
    unknown:  { label: "\u2014",           color: "#94a3b8" },
  };
  const { label, color } = map[s];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "4px",
      background: color + "18", color, border: `1px solid ${color + "55"}`,
      borderRadius: "999px", padding: "2px 10px", fontSize: "0.72rem", fontWeight: 700, whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

// -- Filter type ---------------------------------------------------------------

type FilterTab = "all" | "active" | "revoking" | "revoked" | "in-progress" | "failed";

function matchesFilter(r: AgentCredentialRecord, rev: RevStatus, tab: FilterTab): boolean {
  switch (tab) {
    case "all": return true;
    case "active": return r.protocolState === "CredentialSent" && rev === "active";
    case "revoking": return rev === "revoking";
    case "revoked": return rev === "revoked";
    case "in-progress": return IN_PROGRESS_STATES.has(r.protocolState);
    case "failed": return r.protocolState === "ProblemReportPending";
    default: return true;
  }
}

// -- Detail Modal --------------------------------------------------------------

interface DetailModalProps {
  record: AgentCredentialRecord;
  revInfo?: IssuedCredential;
  onClose: () => void;
}

function DetailModal({ record, revInfo, onClose }: DetailModalProps) {
  const claims = record.claims as Record<string, unknown> | undefined;
  const revStatus = getRevStatus(revInfo);

  const overlay: CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000, padding: "1rem",
  };
  const modal: CSSProperties = {
    background: "#fff", borderRadius: "14px", padding: "0",
    maxWidth: "580px", width: "100%",
    boxShadow: "0 24px 64px rgba(0,0,0,0.3)", maxHeight: "90vh", overflowY: "auto",
  };

  const Field = ({ label, value, mono = false }: { label: string; value?: string | number | null; mono?: boolean }) =>
    value != null ? (
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8", marginBottom: "3px" }}>{label}</div>
        <div style={{
          fontSize: "0.875rem", color: "#1e293b",
          fontFamily: mono ? "monospace" : undefined,
          wordBreak: mono ? "break-all" : undefined,
          background: mono ? "#f1f5f9" : undefined,
          padding: mono ? "4px 8px" : undefined,
          borderRadius: mono ? "4px" : undefined,
        }}>{String(value)}</div>
      </div>
    ) : null;

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: "#f8fafc", borderRadius: "8px", padding: "1rem 1.25rem", marginBottom: "1rem" }}>
      <div style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#64748b", marginBottom: "0.75rem" }}>{title}</div>
      {children}
    </div>
  );

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        {/* Coloured header bar */}
        <div style={{
          background: revStatus === "revoked" ? "#dc2626" : revStatus === "revoking" ? "#d97706" : "#0f3460",
          borderRadius: "14px 14px 0 0", padding: "1.25rem 1.5rem",
          display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        }}>
          <div>
            <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "rgba(255,255,255,0.65)", marginBottom: "4px" }}>Diploma Record</div>
            <h2 style={{ margin: 0, fontSize: "1.2rem", color: "#fff", fontWeight: 700 }}>{(claims?.studentName as string) ?? "\u2014"}</h2>
            <div style={{ fontSize: "0.82rem", color: "rgba(255,255,255,0.8)", marginTop: "3px" }}>{(claims?.degree as string) ?? ""}</div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}>{"\u2715"}</button>
        </div>

        <div style={{ padding: "1.25rem 1.5rem" }}>
          {/* Status row */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "1.25rem", flexWrap: "wrap" }}>
            <IssueBadge state={record.protocolState} />
            <RevBadge info={revInfo} />
          </div>

          <Section title="Student">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1rem" }}>
              <Field label="Full Name" value={claims?.studentName as string} />
              <Field label="Student ID" value={claims?.studentId as string} />
              <Field label="Graduation Date" value={claims?.graduationDate as string} />
              {claims?.gpa != null && <Field label="GPA" value={`${claims.gpa} / 4.0`} />}
            </div>
          </Section>

          {/* Revocation section — only shown when there's revocation info */}
          {revInfo && revStatus !== "active" && (
            <div style={{
              background: revStatus === "revoked" ? "#fef2f2" : "#fffbeb",
              border: `1px solid ${revStatus === "revoked" ? "#fca5a5" : "#fcd34d"}`,
              borderRadius: "8px", padding: "1rem 1.25rem", marginBottom: "1rem",
            }}>
              <div style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: revStatus === "revoked" ? "#dc2626" : "#d97706", marginBottom: "0.75rem" }}>
                {revStatus === "revoked" ? "\u2715 Revocation" : "\u23f3 Revocation Pending"}
              </div>
              {revInfo.revocationReason && (
                <div style={{ marginBottom: "0.5rem" }}>
                  <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8", marginBottom: "3px" }}>Reason</div>
                  <div style={{ fontSize: "0.875rem", color: "#1e293b" }}>{revInfo.revocationReason}</div>
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1rem" }}>
                {revInfo.revocationPendingAt && (
                  <div>
                    <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8", marginBottom: "3px" }}>Initiated</div>
                    <div style={{ fontSize: "0.82rem", color: "#64748b" }}>{new Date(revInfo.revocationPendingAt).toLocaleString()}</div>
                  </div>
                )}
                {revInfo.revocationConfirmedAt && (
                  <div>
                    <div style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8", marginBottom: "3px" }}>Confirmed</div>
                    <div style={{ fontSize: "0.82rem", color: "#64748b" }}>{new Date(revInfo.revocationConfirmedAt).toLocaleString()}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          <Section title="Credential">
            <Field label="Record ID" value={record.recordId} mono />
            <Field label="Thread ID" value={record.thid} mono />
            <Field label="Connection ID" value={record.connectionId} mono />
            <Field label="Format" value={record.credentialFormat} />
            <Field label="Issued By (DID)" value={record.issuingDID ?? (claims?.universityDid as string)} mono />
            {record.subjectId && <Field label="Student DID" value={record.subjectId} mono />}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1rem" }}>
              <Field label="Created" value={new Date(record.createdAt).toLocaleString()} />
              <Field label="Updated" value={new Date(record.updatedAt).toLocaleString()} />
            </div>
          </Section>

          {revInfo?.cardanoscanUrl && (
            <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "1rem 1.25rem", marginBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#1d4ed8", marginBottom: "4px" }}>⛓ Blockchain Anchor — Issuance</div>
                <div style={{ fontSize: "0.75rem", color: "#475569", fontFamily: "monospace", wordBreak: "break-all" }}>{revInfo.cardanoTxHash}</div>
              </div>
              <a href={revInfo.cardanoscanUrl} target="_blank" rel="noopener noreferrer" style={{ flexShrink: 0, padding: "6px 14px", background: "#1d4ed8", color: "#fff", borderRadius: "6px", textDecoration: "none", fontSize: "0.78rem", fontWeight: 700, whiteSpace: "nowrap" }}>
                View on Cardanoscan ↗
              </a>
            </div>
          )}

          {revInfo?.cardanoRevocationUrl && (
            <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: "8px", padding: "1rem 1.25rem", marginBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#dc2626", marginBottom: "4px" }}>⛓ Blockchain Anchor — Revocation</div>
                <div style={{ fontSize: "0.75rem", color: "#475569", fontFamily: "monospace", wordBreak: "break-all" }}>{revInfo.cardanoRevocationTxHash}</div>
              </div>
              <a href={revInfo.cardanoRevocationUrl} target="_blank" rel="noopener noreferrer" style={{ flexShrink: 0, padding: "6px 14px", background: "#dc2626", color: "#fff", borderRadius: "6px", textDecoration: "none", fontSize: "0.78rem", fontWeight: 700, whiteSpace: "nowrap" }}>
                View on Cardanoscan ↗
              </a>
            </div>
          )}

          {record.jwt && (
            <Section title="JWT Token">
              <div style={{ fontSize: "0.7rem", fontFamily: "monospace", wordBreak: "break-all", color: "#475569", maxHeight: "80px", overflowY: "auto", background: "#f1f5f9", padding: "6px 8px", borderRadius: "4px" }}>
                {record.jwt}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(record.jwt!)}
                style={{ marginTop: "0.5rem", fontSize: "0.75rem", padding: "4px 12px", background: "#0f3460", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}
              >
                Copy JWT
              </button>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Table row -----------------------------------------------------------------

const td: CSSProperties = { padding: "11px 14px", fontSize: "0.875rem", verticalAlign: "middle" };

interface RowProps {
  record: AgentCredentialRecord;
  revInfo?: IssuedCredential;
  onClick: () => void;
}

function RecordRow({ record, revInfo, onClick }: RowProps) {
  const claims = record.claims as Record<string, unknown> | undefined;
  const [hover, setHover] = useState(false);
  const rev = getRevStatus(revInfo);

  const rowBg = hover
    ? rev === "revoked" ? "#fff0f0" : rev === "revoking" ? "#fffcf0" : "#f8fafc"
    : rev === "revoked" ? "#fff5f5" : rev === "revoking" ? "#fffdf0" : "#fff";

  return (
    <tr
      style={{ borderBottom: "1px solid #f1f5f9", cursor: "pointer", background: rowBg, transition: "background 0.12s" }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <td style={td}>
        <div style={{ fontWeight: 600, color: "#1e293b" }}>{(claims?.studentName as string) ?? "\u2014"}</div>
        <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{(claims?.studentId as string) ?? ""}</div>
      </td>
      <td style={{ ...td, maxWidth: "220px" }}>
        <div style={{ fontSize: "0.82rem", color: "#334155", lineHeight: 1.35 }}>{(claims?.degree as string) ?? "\u2014"}</div>
      </td>
      <td style={{ ...td, whiteSpace: "nowrap" }}>{(claims?.graduationDate as string) ?? "\u2014"}</td>
      <td style={{ ...td, color: claims?.gpa != null ? "#1e293b" : "#cbd5e1", textAlign: "center" }}>
        {claims?.gpa != null ? String(claims.gpa) : "\u2014"}
      </td>
      <td style={td}><IssueBadge state={record.protocolState} /></td>
      <td style={td}><RevBadge info={revInfo} /></td>
      <td style={{ ...td, whiteSpace: "nowrap", color: "#64748b", fontSize: "0.8rem" }}>
        {new Date(record.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
      </td>
      <td style={{ ...td, color: "#3b82f6", fontSize: "0.78rem", whiteSpace: "nowrap" }}>Details &#x2192;</td>
    </tr>
  );
}

// -- Dashboard -----------------------------------------------------------------

export function Dashboard() {
  const { records, loading, error, refresh } = useDiplomas();
  const [students, setStudents] = useState<Awaited<ReturnType<typeof fetchStudents>>>([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");
  const [selected, setSelected] = useState<AgentCredentialRecord | null>(null);

  // Fetch students (for revocation data) on mount, refresh every 8 s
  useEffect(() => {
    const load = () => fetchStudents().then(setStudents).catch(() => {});
    load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
  }, []);

  // Build credentialRecordId -> IssuedCredential lookup from all students
  const revMap = useMemo(() => {
    const map = new Map<string, IssuedCredential>();
    for (const s of students) {
      for (const c of s.issuedCredentials ?? []) {
        map.set(c.credentialRecordId, c);
      }
    }
    return map;
  }, [students]);

  // Sort newest first
  const sorted = useMemo(
    () => [...records].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [records]
  );

  // Filter by search + tab
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sorted.filter((r) => {
      const claims = r.claims as Record<string, unknown> | undefined;
      if (q) {
        const name = ((claims?.studentName as string) ?? "").toLowerCase();
        const degree = ((claims?.degree as string) ?? "").toLowerCase();
        const sid = ((claims?.studentId as string) ?? "").toLowerCase();
        if (!name.includes(q) && !degree.includes(q) && !sid.includes(q)) return false;
      }
      return matchesFilter(r, getRevStatus(revMap.get(r.recordId)), tab);
    });
  }, [sorted, search, tab, revMap]);

  // Compute stats
  const stats = useMemo(() => {
    const all = sorted;
    return {
      total: all.length,
      active: all.filter((r) => r.protocolState === "CredentialSent" && getRevStatus(revMap.get(r.recordId)) === "active").length,
      revoking: all.filter((r) => getRevStatus(revMap.get(r.recordId)) === "revoking").length,
      revoked: all.filter((r) => getRevStatus(revMap.get(r.recordId)) === "revoked").length,
      inProgress: all.filter((r) => IN_PROGRESS_STATES.has(r.protocolState)).length,
      failed: all.filter((r) => r.protocolState === "ProblemReportPending").length,
    };
  }, [sorted, revMap]);

  const tabDefs: { key: FilterTab; label: string; count: number; color: string }[] = [
    { key: "all",         label: "All",         count: stats.total,      color: "#0f3460" },
    { key: "active",      label: "Active",       count: stats.active,     color: "#16a34a" },
    { key: "revoking",    label: "Revoking",     count: stats.revoking,   color: "#d97706" },
    { key: "revoked",     label: "Revoked",      count: stats.revoked,    color: "#dc2626" },
    { key: "in-progress", label: "In Progress",  count: stats.inProgress, color: "#3b82f6" },
    { key: "failed",      label: "Failed",       count: stats.failed,     color: "#ef4444" },
  ];

  return (
    <>
      {/* Page header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.75rem" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 800, color: "#0f1c33" }}>Dashboard</h1>
          <p style={{ margin: "3px 0 0", fontSize: "0.875rem", color: "#64748b" }}>All issued diplomas and their current status</p>
        </div>
        <button
          onClick={refresh}
          style={{ padding: "7px 16px", borderRadius: "8px", border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontSize: "0.82rem", fontWeight: 600, color: "#475569", display: "flex", alignItems: "center", gap: "6px" }}
        >
          {"\u21bb"} Refresh
        </button>
      </div>

      {/* University DID */}
      {import.meta.env.VITE_UNIVERSITY_DID && (
        <div style={{ background: "#f0f4ff", border: "1px solid #c7d2fe", borderRadius: "8px", padding: "0.75rem 1.25rem", marginBottom: "1.5rem", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontWeight: 700, color: "#3730a3", whiteSpace: "nowrap" }}>University DID</span>
          <code style={{ background: "#e0e7ff", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", wordBreak: "break-all", color: "#3730a3" }}>{import.meta.env.VITE_UNIVERSITY_DID}</code>
        </div>
      )}

      {/* Stats cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: "0.875rem", marginBottom: "1.75rem" }}>
        {[
          { label: "Total",       value: stats.total,      accent: "#0f3460",  icon: "\u{1F393}" },
          { label: "Active",      value: stats.active,     accent: "#16a34a",  icon: "\u2713" },
          { label: "Revoking",    value: stats.revoking,   accent: "#d97706",  icon: "\u23f3" },
          { label: "Revoked",     value: stats.revoked,    accent: "#dc2626",  icon: "\u2715" },
          { label: "In Progress", value: stats.inProgress, accent: "#3b82f6",  icon: "\u21bb" },
          { label: "Failed",      value: stats.failed,     accent: "#ef4444",  icon: "!" },
        ].map(({ label, value, accent, icon }) => (
          <div key={label} style={{
            background: "#fff", borderRadius: "10px",
            border: "1px solid #e2e8f0", borderTop: `3px solid ${accent}`,
            padding: "1rem 1.25rem",
            cursor: value > 0 ? "pointer" : "default",
            transition: "box-shadow 0.15s",
          }}
            onClick={() => {
              if (value === 0) return;
              const map: Record<string, FilterTab> = { Total: "all", Active: "active", Revoking: "revoking", Revoked: "revoked", "In Progress": "in-progress", Failed: "failed" };
              setTab(map[label] ?? "all");
            }}
          >
            <div style={{ fontSize: "0.85rem", marginBottom: "4px" }}>{icon}</div>
            <div style={{ fontSize: "1.75rem", fontWeight: 800, color: accent, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Search + filter bar */}
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: "10px", marginBottom: "1rem", overflow: "hidden" }}>
        <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #f1f5f9", display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by student name, degree or ID…"
            style={{
              flex: 1, padding: "7px 12px", border: "1px solid #e2e8f0", borderRadius: "7px",
              fontSize: "0.875rem", outline: "none", background: "#f8fafc",
            }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{ padding: "6px 12px", border: "1px solid #e2e8f0", borderRadius: "7px", background: "#fff", cursor: "pointer", fontSize: "0.8rem", color: "#64748b" }}>
              Clear
            </button>
          )}
        </div>

        {/* Status tabs */}
        <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #f1f5f9", overflowX: "auto" }}>
          {tabDefs.map(({ key, label, count, color }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                padding: "9px 16px", border: "none", background: "none", cursor: "pointer",
                fontSize: "0.8rem", fontWeight: 600, whiteSpace: "nowrap",
                color: tab === key ? color : "#94a3b8",
                borderBottom: tab === key ? `2px solid ${color}` : "2px solid transparent",
                marginBottom: "-2px",
                transition: "color 0.12s",
              }}
            >
              {label}
              {count > 0 && (
                <span style={{
                  marginLeft: "5px", fontSize: "0.68rem", fontWeight: 700,
                  background: tab === key ? color + "20" : "#f1f5f9",
                  color: tab === key ? color : "#94a3b8",
                  borderRadius: "999px", padding: "1px 6px",
                }}>{count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Table */}
        {loading && <div style={{ padding: "2.5rem", textAlign: "center", color: "#94a3b8" }}>Loading&#x2026;</div>}
        {error && <div style={{ padding: "2rem", color: "#dc2626", fontSize: "0.875rem" }}>{error}</div>}
        {!loading && !error && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  {["Student", "Degree", "Grad Date", "GPA", "Issue Status", "Revocation", "Date", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "9px 14px", fontSize: "0.68rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: "3rem", color: "#cbd5e1" }}>
                      {records.length === 0
                        ? "No diplomas issued yet. Go to Issue Diploma to get started."
                        : "No records match your current filter."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => (
                    <RecordRow
                      key={r.recordId}
                      record={r}
                      revInfo={revMap.get(r.recordId)}
                      onClick={() => setSelected(r)}
                    />
                  ))
                )}
              </tbody>
            </table>
            {filtered.length > 0 && (
              <div style={{ padding: "0.6rem 1rem", borderTop: "1px solid #f1f5f9", fontSize: "0.75rem", color: "#94a3b8" }}>
                Showing {filtered.length} of {records.length} records &middot; Newest first
              </div>
            )}
          </div>
        )}
      </div>

      {selected && (
        <DetailModal
          record={selected}
          revInfo={revMap.get(selected.recordId)}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}


