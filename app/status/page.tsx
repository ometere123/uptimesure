"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusPill";
import { CORE_ADDRESS, hasDeployment } from "@/lib/config";
import { publicClient } from "@/lib/chain";
import { getSupabase } from "@/lib/supabase";
import { relativeDate, short } from "@/lib/format";

type Health = {
  chain: "checking" | "online" | "error";
  block: string | null;
  supabase: "checking" | "online" | "not-configured" | "error";
  guarantees: number | null;
  latestObservation: { observed_at: string; healthy: boolean; tx_status: string } | null;
};

export default function StatusPage() {
  const [health, setHealth] = useState<Health>({
    chain: "checking",
    block: null,
    supabase: "checking",
    guarantees: null,
    latestObservation: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const block = await publicClient.getBlockNumber();
        if (!cancelled) setHealth((current) => ({ ...current, chain: "online", block: block.toString() }));
      } catch {
        if (!cancelled) setHealth((current) => ({ ...current, chain: "error" }));
      }

      const supabase = getSupabase();
      if (!supabase) {
        if (!cancelled) setHealth((current) => ({ ...current, supabase: "not-configured" }));
        return;
      }

      try {
        const [countResult, latestResult] = await Promise.all([
          supabase.from("guarantees").select("id", { count: "exact", head: true }),
          supabase.from("observations").select("observed_at,healthy,tx_status").order("observed_at", { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (countResult.error) throw countResult.error;
        if (latestResult.error) throw latestResult.error;
        if (!cancelled) {
          setHealth((current) => ({
            ...current,
            supabase: "online",
            guarantees: countResult.count ?? 0,
            latestObservation: latestResult.data ?? null,
          }));
        }
      } catch {
        if (!cancelled) setHealth((current) => ({ ...current, supabase: "error" }));
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  const chainLabel = health.chain === "online" ? "Online" : health.chain === "checking" ? "Checking" : "Unavailable";
  const dbLabel = health.supabase === "online" ? "Online" : health.supabase === "checking" ? "Checking" : health.supabase === "not-configured" ? "Not configured" : "Unavailable";

  return (
    <section className="shell page-section">
      <div className="page-heading">
        <p className="eyebrow">Live infrastructure</p>
        <h1>System status</h1>
        <p>This page performs live public checks. It does not substitute hard-coded green states when a dependency is missing.</p>
      </div>

      <div className="metric-grid metric-grid-four">
        <div className="metric card"><span>Base Sepolia RPC</span><strong>{chainLabel}</strong><small>{health.block ? `Block ${health.block}` : "Public read path"}</small></div>
        <div className="metric card"><span>UptimeSure contract</span><strong>{hasDeployment() ? "Configured" : "Pending"}</strong><small>{hasDeployment() ? short(CORE_ADDRESS) : "No address injected"}</small></div>
        <div className="metric card"><span>Supabase read model</span><strong>{dbLabel}</strong><small>{health.guarantees == null ? "Public index" : `${health.guarantees} indexed guarantees`}</small></div>
        <div className="metric card"><span>Latest monitor result</span><strong>{health.latestObservation ? (health.latestObservation.healthy ? "Healthy" : "Failure") : "None yet"}</strong><small>{health.latestObservation ? relativeDate(health.latestObservation.observed_at) : "Awaiting first real probe"}</small></div>
      </div>

      <div className="detail-grid">
        <article className="detail-card card">
          <p className="eyebrow">Release readiness</p>
          <dl>
            <div><dt>Frontend</dt><dd><StatusPill status="Healthy" /></dd></div>
            <div><dt>Base Sepolia RPC</dt><dd><StatusPill status={health.chain === "online" ? "Healthy" : health.chain === "checking" ? "Checking" : "Failure"} /></dd></div>
            <div><dt>Contract deployment</dt><dd><StatusPill status={hasDeployment() ? "Healthy" : "Pending"} /></dd></div>
            <div><dt>Supabase runtime</dt><dd><StatusPill status={health.supabase === "online" ? "Healthy" : health.supabase === "checking" ? "Checking" : "Pending"} /></dd></div>
          </dl>
        </article>
        <article className="detail-card card">
          <p className="eyebrow">Trust boundary</p>
          <h2>Monitoring can report. It cannot redirect funds.</h2>
          <p className="card-note">The dedicated monitor wallet is limited to MONITOR_ROLE. Beneficiary, payout size, maximum payout count, expiry and remaining coverage are contract state.</p>
        </article>
      </div>
    </section>
  );
}
