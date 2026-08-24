"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { BASE_SEPOLIA_EXPLORER } from "@/lib/config";
import { connectWallet, topUpGuarantee, withdrawExpiredGuarantee, WalletConnection } from "@/lib/chain";
import { guaranteeStatus, relativeDate, short, usdc } from "@/lib/format";
import { getSupabase } from "@/lib/supabase";
import { GuaranteeRow, IncidentRow, ObservationRow } from "@/lib/types";

export default function GuaranteeDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [g, setG] = useState<GuaranteeRow | null>(null);
  const [observations, setObservations] = useState<ObservationRow[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [topUpAmount, setTopUpAmount] = useState("25");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionTx, setActionTx] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !Number.isSafeInteger(id) || id <= 0) { setError("Invalid guarantee or Supabase is not configured."); setLoading(false); return; }
    Promise.all([
      supabase.from("guarantees").select("*").eq("id", id).single(),
      supabase.from("observations").select("*").eq("guarantee_id", id).order("observed_at", { ascending: false }).limit(50),
      supabase.from("incidents").select("*").eq("guarantee_id", id).order("confirmed_at", { ascending: false }).limit(20),
    ]).then(([guarantee, observationRows, incidentRows]) => {
      if (guarantee.error) setError(guarantee.error.message);
      else setG(guarantee.data as GuaranteeRow);
      setObservations((observationRows.data || []) as ObservationRow[]);
      setIncidents((incidentRows.data || []) as IncidentRow[]);
      setLoading(false);
    });
  }, [id]);

  async function connectProvider() {
    setActionBusy(true); setActionMessage(null); setActionTx(null);
    try {
      const next = await connectWallet();
      setConnection(next);
      if (g && next.address.toLowerCase() !== g.provider.toLowerCase()) {
        setActionMessage("Connected wallet is not the provider. Contract management actions will revert for this address.");
      }
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Wallet connection failed");
    } finally {
      setActionBusy(false);
    }
  }

  async function topUp() {
    if (!connection || !g) return;
    setActionBusy(true); setActionMessage("Preparing test-USDC approval and top-up…"); setActionTx(null);
    try {
      const amount = parseUnits(topUpAmount, 6);
      const result = await topUpGuarantee(connection, BigInt(g.id), amount);
      setActionTx(result.topUpHash);
      setActionMessage("Coverage top-up confirmed on Base Sepolia. The public read model will refresh on the next sync cycle.");
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Coverage top-up failed");
    } finally {
      setActionBusy(false);
    }
  }

  async function withdraw() {
    if (!connection || !g) return;
    setActionBusy(true); setActionMessage("Submitting expired-coverage withdrawal…"); setActionTx(null);
    try {
      const hash = await withdrawExpiredGuarantee(connection, BigInt(g.id));
      setActionTx(hash);
      setActionMessage("Unused expired coverage returned to the provider. The public read model will refresh on the next sync cycle.");
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Expired coverage withdrawal failed");
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) return <section className="shell page-section"><div className="loading-card card">Loading guarantee proof…</div></section>;
  if (error || !g) return <section className="shell page-section"><EmptyState title="Guarantee unavailable" body={error || "The indexed guarantee does not exist."} /></section>;
  const status = guaranteeStatus(g.active, g.withdrawn, g.expires_at);
  const connectedProvider = connection?.address.toLowerCase() === g.provider.toLowerCase();
  const expired = new Date(g.expires_at).getTime() <= Date.now();

  return <section className="shell page-section">
    <div className="page-heading row-between">
      <div><p className="eyebrow">Guarantee #{g.id}</p><h1>{g.endpoint_url}</h1><p>Criteria hash <code>{short(g.criteria_hash, 12, 10)}</code></p></div>
      <StatusPill status={status} />
    </div>
    <div className="metric-grid metric-grid-four">
      <div className="metric card"><span>Coverage remaining</span><strong>{usdc(g.remaining_coverage)}</strong></div>
      <div className="metric card"><span>Payout per incident</span><strong>{usdc(g.payout_per_incident)}</strong></div>
      <div className="metric card"><span>Failure state</span><strong>{g.consecutive_failures}/{g.failure_threshold}</strong></div>
      <div className="metric card"><span>Paid incidents</span><strong>{g.paid_payouts}/{g.max_payouts}</strong></div>
    </div>
    <div className="detail-grid">
      <article className="card detail-card"><p className="eyebrow">Monitoring policy</p><dl>
        <div><dt>HTTP status</dt><dd>{g.expected_status}</dd></div><div><dt>Body fragment</dt><dd>{g.expected_fragment || "Not required"}</dd></div>
        <div><dt>Max latency</dt><dd>{g.max_latency_ms} ms</dd></div><div><dt>Interval</dt><dd>{g.check_interval_seconds}s</dd></div>
        <div><dt>Failure threshold</dt><dd>{g.failure_threshold} consecutive</dd></div><div><dt>Minimum outage</dt><dd>{g.min_outage_seconds}s</dd></div>
        <div><dt>Last observation</dt><dd>{relativeDate(g.last_observed_at)}</dd></div><div><dt>Expires</dt><dd>{relativeDate(g.expires_at)}</dd></div>
      </dl></article>
      <article className="card detail-card"><p className="eyebrow">Parties</p><dl>
        <div><dt>Provider</dt><dd><a href={`${BASE_SEPOLIA_EXPLORER}/address/${g.provider}`} target="_blank" rel="noreferrer">{short(g.provider)}</a></dd></div>
        <div><dt>Beneficiary</dt><dd><a href={`${BASE_SEPOLIA_EXPLORER}/address/${g.beneficiary}`} target="_blank" rel="noreferrer">{short(g.beneficiary)}</a></dd></div>
        <div><dt>Contract</dt><dd><a href={`${BASE_SEPOLIA_EXPLORER}/address/${g.contract_address}`} target="_blank" rel="noreferrer">{short(g.contract_address)}</a></dd></div>
      </dl><p className="card-note">The monitor role cannot edit these addresses or redirect compensation.</p></article>
    </div>

    <div className="section-subheading"><div><p className="eyebrow">Provider controls</p><h2>Manage coverage</h2></div><span>{connection ? `Wallet ${short(connection.address)}` : "Provider wallet required"}</span></div>
    <div className="manage-card card">
      {!connection ? <div className="manage-copy"><div><strong>Provider-only contract actions</strong><p>Connect the provider wallet to add extra test-USDC coverage or reclaim unused coverage after expiry.</p></div><button className="button button-secondary" onClick={connectProvider} disabled={actionBusy}>{actionBusy ? "Connecting…" : "Connect provider"}</button></div> : <>
        <div className="manage-copy"><div><strong>{connectedProvider ? "Provider verified" : "Different wallet connected"}</strong><p>{connectedProvider ? "Contract permissions will still enforce every action onchain." : "Switch to the provider address shown above before submitting a management transaction."}</p></div><button className="button button-ghost button-small" onClick={connectProvider} disabled={actionBusy}>Change wallet</button></div>
        <div className="manage-actions">
          <label>Extra coverage (test USDC)<input value={topUpAmount} onChange={(e) => setTopUpAmount(e.target.value)} inputMode="decimal" disabled={!connectedProvider || expired || !g.active || actionBusy} /></label>
          <button className="button button-secondary" type="button" onClick={topUp} disabled={!connectedProvider || expired || !g.active || actionBusy}>{actionBusy ? "Working…" : "Top up coverage"}</button>
          <button className="button button-primary" type="button" onClick={withdraw} disabled={!connectedProvider || !expired || g.withdrawn || actionBusy}>{actionBusy ? "Working…" : "Withdraw expired coverage"}</button>
        </div>
      </>}
      {actionMessage ? <div className="notice">{actionMessage}{actionTx ? <> <a href={`${BASE_SEPOLIA_EXPLORER}/tx/${actionTx}`} target="_blank" rel="noreferrer">View transaction</a></> : null}</div> : null}
    </div>

    <div className="section-subheading"><div><p className="eyebrow">Evidence stream</p><h2>Recent observations</h2></div><span>{observations.length} loaded</span></div>
    {observations.length === 0 ? <EmptyState title="No observations indexed yet" body="The first scheduled monitor cycle will appear here after the contract is deployed and Supabase Cron is active." /> : <div className="table-card card">
      <div className="table-row observation-head"><span>Observed</span><span>Result</span><span>HTTP</span><span>Latency</span><span>Chain</span></div>
      {observations.map((o) => <div className="table-row observation-head" key={o.observation_id}><span>{relativeDate(o.observed_at)}</span><span><StatusPill status={o.healthy ? "Healthy" : "Failure"} /></span><span>{o.http_status ?? "—"}</span><span>{o.latency_ms == null ? "—" : `${o.latency_ms}ms`}</span><span>{o.tx_hash ? <a href={`${BASE_SEPOLIA_EXPLORER}/tx/${o.tx_hash}`} target="_blank" rel="noreferrer">{short(o.tx_hash)}</a> : o.tx_status === "not_required" ? "evidence only" : o.tx_status}</span></div>)}
    </div>}
    <div className="section-subheading"><div><p className="eyebrow">Settlement history</p><h2>Incidents</h2></div><span>{incidents.length} loaded</span></div>
    {incidents.length === 0 ? <EmptyState title="No confirmed incidents" body="A breach appears only after the configured deterministic threshold and minimum outage duration are satisfied." /> : <div className="cards-list">{incidents.map((i) => <article className="incident-card card" key={i.id}><div><p className="eyebrow">Incident #{i.id}</p><h3>{i.recovered_at ? "Recovered" : "Active outage"}</h3><p>Started {relativeDate(i.started_at)} · confirmed {relativeDate(i.confirmed_at)}</p></div><div className="guarantee-card-side"><strong>{usdc(i.payout_amount)}</strong><small>{i.recovered_at ? `Recovered ${relativeDate(i.recovered_at)}` : "Awaiting recovery"}</small></div></article>)}</div>}
  </section>;
}
