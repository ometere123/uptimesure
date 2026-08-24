"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { connectWallet } from "@/lib/chain";
import { short } from "@/lib/format";

const LINKS = [
  { href: "/guarantees", label: "Guarantees" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/status", label: "Status" },
  { href: "/create", label: "Create" },
];

export function Nav() {
  const pathname = usePathname();
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const result = await connectWallet();
      setAddress(result.address);
    } catch (e) {
      // Shown in the header rather than through window.alert: a wallet rejection or a wrong-network message is
      // something to read next to the button that caused it, not to dismiss from a modal.
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
    } finally {
      setBusy(false);
    }
  }

  const current = (href: string) => (pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined);

  return (
    <header className="nav-wrap">
      <div className="nav shell">
        <Link href="/" className="brand">
          <span className="brand-mark">U</span>
          <span>UptimeSure</span>
        </Link>
        <nav className="nav-links" aria-label="Primary">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} aria-current={current(link.href)}>
              {link.label}
            </Link>
          ))}
        </nav>
        <button className="button button-small button-ghost" onClick={connect} disabled={busy}>
          {address ? short(address) : busy ? "Connecting…" : "Connect wallet"}
        </button>
      </div>
      {/*
        Below 900px the primary row is hidden for width, so the same links repeat here as a scrollable strip.
        A plain row rather than a toggled drawer: there is no open/closed state to get wrong, no focus trap to
        maintain, and navigation still works if the JS bundle fails to hydrate.
      */}
      <nav className="nav-compact" aria-label="Primary, compact">
        <div className="shell nav-compact-inner">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} aria-current={current(link.href)}>
              {link.label}
            </Link>
          ))}
        </div>
      </nav>
      {error ? (
        <div className="shell">
          <div className="notice notice-error nav-error">{error}</div>
        </div>
      ) : null}
    </header>
  );
}
