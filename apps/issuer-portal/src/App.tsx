import type { CSSProperties } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard.js";
import { Connections } from "./pages/Connections.js";
import { Students } from "./pages/Students.js";

const navStyle: CSSProperties = {
  display: "flex",
  gap: "1.5rem",
  padding: "1rem 2rem",
  background: "#1e3a5f",
  color: "#fff",
  alignItems: "center",
};

const linkStyle = ({
  isActive,
}: {
  isActive: boolean;
}): CSSProperties => ({
  color: isActive ? "#63b3ed" : "#a0aec0",
  textDecoration: "none",
  fontWeight: isActive ? 700 : 400,
  fontSize: "0.95rem",
});

export default function App() {
  return (
    <>
      <nav style={navStyle}>
        <span style={{ fontWeight: 700, fontSize: "1.1rem", marginRight: "1rem" }}>
          🎓 Diploma Issuer Portal
        </span>
        <NavLink to="/" style={linkStyle} end>
          Dashboard
        </NavLink>
        <NavLink to="/students" style={linkStyle}>
          Students
        </NavLink>
        <NavLink to="/connections" style={linkStyle}>
          Connections
        </NavLink>
      </nav>

      <main style={{ padding: "2rem", maxWidth: "1100px", margin: "0 auto" }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/students" element={<Students />} />
          <Route path="/connections" element={<Connections />} />
        </Routes>
      </main>
    </>
  );
}
