"use client";

import Link from "next/link";
import { useState } from "react";
import { connectWallet } from "@/lib/chain";
import { getSupabase } from "@/lib/supabase";
import { GuaranteeRow } from "@/lib/types";
import { guaranteeStatus, short, usdc } from "@/lib/format";
import { StatusPill } from "@/components/StatusPill";
import { EmptyState } from "@/components/EmptyState";

export default function DashboardPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [rows, setRows] = useState<GuaranteeRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true); setError(null);
    try {
      const connection = await connectWallet();
      setWallet(connection.address);
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase public configuration is not set yet.");
      const address = connection.address.toLowerCase();
      const result = await supabase.from("guarantees").select("*").or(`provider.eq.${address},beneficiary.eq.${address}`).order("id", { ascending: false });
      if (result.error) throw result.error;
      setRows((result.data || []) as GuaranteeRow[]);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load dashboard"); }
    finally { setBusy(false); }
  }

  const protectedCount = rows.filter((g) => guaranteeStatus(g.active, g.withdrawn, g.expires_at) === "Protected").length;
  const coverage = rows.reduce((sum, g) => sum + BigInt(g.remaining_coverage || 0), 0n);
  const paid = rows.reduce((sum, g) => sum + BigInt(g.payout_per_incident || 0) * BigInt(g.paid_payouts || 0), 0n);

  return (
    <section className="shell page-section">
      <div className="page-heading row-between">
        <div><p className="eyebrow">Provider + beneficiary workspace</p><h1>Dashboard</h1><p>{wallet ? `Connected ${short(wallet)}` : "Connect your wallet to load only guarantees where you are provider or beneficiary."}</p></div>
        <button className="button button-primary" onClick={load} disabled={busy}>{busy ? "Loading…" : wallet ? "Refresh" : "Connect & load"}</button>
      </div>
      {error ? <div className="notice notice-error">{error}</div> : null}
      {wallet ? <div className="metric-grid">
        <div className="metric card"><span>Protected guarantees</span><strong>{protectedCount}</strong></div>
        <div className="metric card"><span>Coverage remaining</span><strong>{usdc(coverage)}</strong></div>
        <div className="metric card"><span>Compensation paid</span><strong>{usdc(paid)}</strong></div>
      </div> : null}
      {wallet && rows.length === 0 && !busy ? <EmptyState title="Nothing tied to this wallet yet" body="Create a provider guarantee or use this wallet as a beneficiary." action={{ href: "/create", label: "Create guarantee" }} /> : null}
      {rows.length ? <div className="cards-list">
        {rows.map((g) => <Link href={`/guarantees/${g.id}`} key={g.id} className="guarantee-card card">
          <div><p className="eyebrow">Guarantee #{g.id}</p><h3>{g.endpoint_url}</h3><p>{g.provider === wallet?.toLowerCase() ? "Provider" : "Beneficiary"}</p></div>
          <div className="guarantee-card-side"><StatusPill status={guaranteeStatus(g.active, g.withdrawn, g.expires_at)} /><strong>{usdc(g.remaining_coverage)}</strong><small>{g.consecutive_failures}/{g.failure_threshold} failures</small></div>
        </Link>)}
      </div> : null}
    </section>
  );
}
