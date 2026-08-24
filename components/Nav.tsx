"use client";

import Link from "next/link";
import { useState } from "react";
import { connectWallet } from "@/lib/chain";
import { short } from "@/lib/format";

export function Nav() {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const result = await connectWallet();
      setAddress(result.address);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Wallet connection failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="nav-wrap">
      <div className="nav shell">
        <Link href="/" className="brand"><span className="brand-mark">U</span><span>UptimeSure</span></Link>
        <nav className="nav-links">
          <Link href="/guarantees">Guarantees</Link>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/status">Status</Link>
          <Link href="/create">Create</Link>
        </nav>
        <button className="button button-small button-ghost" onClick={connect} disabled={busy}>
          {address ? short(address) : busy ? "Connecting…" : "Connect wallet"}
        </button>
      </div>
    </header>
  );
}
