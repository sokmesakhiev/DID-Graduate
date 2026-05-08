import { useState, useEffect, type CSSProperties } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import { Home } from "./pages/Home.js";
import { Present } from "./pages/Present.js";
import { WalletProvider } from "./context/WalletContext.js";
import { LoginPage } from "./pages/LoginPage.js";
import type { StudentUser } from "./services/authApi.js";

const navStyle: CSSProperties = {
  display: "flex",
  gap: "1.5rem",
  padding: "1rem 2rem",
  background: "#0f3460",
  color: "#fff",
  alignItems: "center",
};

const linkStyle = ({ isActive }: { isActive: boolean }): CSSProperties => ({
  color: isActive ? "#63b3ed" : "#a0aec0",
  textDecoration: "none",
  fontWeight: isActive ? 700 : 400,
  fontSize: "0.95rem",
});

export default function App() {
  const [currentUser, setCurrentUser] = useState<StudentUser | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Restore persisted session on first load.
  // sessionStorage is tab-scoped: survives F5 / hard-refresh, but is cleared
  // automatically when the tab closes.
  //
  // Security properties:
  //   • Shared computer: closing the tab signs the student out — no credentials
  //     left behind for the next person who opens the URL.
  //   • Multiple students, same browser: each tab is fully isolated — Student B
  //     logging into Tab 2 has zero effect on Tab 1.
  //   • Private keys (DID seed + Pluto IndexedDB) are already scoped by userId
  //     UUID and are never readable from another student’s session.
  useEffect(() => {
    const savedToken = sessionStorage.getItem("wallet_token");
    const savedUser  = sessionStorage.getItem("wallet_user");
    if (savedToken && savedUser) {
      try {
        setToken(savedToken);
        setCurrentUser(JSON.parse(savedUser) as StudentUser);
      } catch {
        sessionStorage.removeItem("wallet_token");
        sessionStorage.removeItem("wallet_user");
      }
    }
  }, []);

  const handleAuth = (newToken: string, user: StudentUser, publicDevice: boolean) => {
    sessionStorage.setItem("wallet_token", newToken);
    sessionStorage.setItem("wallet_user",  JSON.stringify(user));
    // Store the public-device flag so useWallet can delete the DB on tab close.
    if (publicDevice) {
      sessionStorage.setItem("wallet_public_device", "true");
    } else {
      sessionStorage.removeItem("wallet_public_device");
    }
    setToken(newToken);
    setCurrentUser(user);
  };

  const logout = () => {
    sessionStorage.removeItem("wallet_token");
    sessionStorage.removeItem("wallet_user");
    sessionStorage.removeItem("wallet_public_device");
    setToken(null);
    setCurrentUser(null);
  };

  if (!currentUser) {
    return <LoginPage onAuth={handleAuth} />;
  }

  return (
    <WalletProvider currentUser={currentUser} token={token} logout={logout}>
      <nav style={navStyle}>
        <span style={{ fontWeight: 700, fontSize: "1.1rem", marginRight: "1rem" }}>
          🎓 Diploma Wallet
        </span>
        <NavLink to="/" style={linkStyle} end>My Diplomas</NavLink>
        <NavLink to="/present" style={linkStyle}>Present Diploma</NavLink>
        <span style={{ marginLeft: "auto", fontSize: "0.875rem", color: "#a0aec0" }}>
          {currentUser.name}
        </span>
        <button
          onClick={logout}
          style={{ background: "transparent", border: "1px solid #4a5568", color: "#a0aec0", borderRadius: "4px", padding: "4px 12px", cursor: "pointer", fontSize: "0.8rem" }}
        >
          Sign out
        </button>
      </nav>
      <main style={{ padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/present" element={<Present />} />
        </Routes>
      </main>
    </WalletProvider>
  );
}
