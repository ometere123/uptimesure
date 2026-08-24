"use client";

import { FormEvent, useMemo, useState } from "react";
import { parseUnits } from "viem";
import { connectWallet, createGuarantee, WalletConnection } from "@/lib/chain";
import { BASE_SEPOLIA_EXPLORER, CORE_ADDRESS, hasDeployment } from "@/lib/config";
import { short } from "@/lib/format";

export default function CreatePage() {
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [expectedStatus, setExpectedStatus] = useState(200);
  const [expectedFragment, setExpectedFragment] = useState("");
  const [maxLatency, setMaxLatency] = useState(2000);
  const [interval, setInterval] = useState(60);
  const [threshold, setThreshold] = useState(3);
  const [minOutage, setMinOutage] = useState(120);
  const [payout, setPayout] = useState("25");
  const [maxPayouts, setMaxPayouts] = useState(4);
  const [days, setDays] = useState(30);

  const totalCoverage = useMemo(() => {
    try { return parseUnits(payout || "0", 6) * BigInt(maxPayouts || 0); } catch { return 0n; }
  }, [payout, maxPayouts]);

  async function connect() {
    setBusy(true); setMessage(null);
    try { setConnection(await connectWallet()); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Wallet connection failed"); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connection) return setMessage("Connect a wallet first.");
    if (!hasDeployment()) return setMessage("The Base Sepolia contract is not configured yet.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(beneficiary)) return setMessage("Enter a valid EVM beneficiary address.");
    if (!endpoint.startsWith("https://")) return setMessage("Monitoring endpoints must use HTTPS.");
    if (minOutage < interval * (threshold - 1)) return setMessage("Minimum outage must cover the configured failure spacing.");
    setBusy(true); setMessage("Checking allowance and preparing transactions…"); setTx(null);
    try {
      const result = await createGuarantee(connection, {
        beneficiary: beneficiary as `0x${string}`,
        endpointUrl: endpoint.trim(),
        expectedStatus,
        expectedFragment: expectedFragment.trim(),
        maxLatencyMs: maxLatency,
        checkIntervalSecs: interval,
        failureThreshold: threshold,
        minOutageSecs: minOutage,
        payoutPerIncident: parseUnits(payout, 6),
        maxPayouts,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + days * 86_400),
        coverageAmount: totalCoverage,
      });
      setTx(result.createHash);
      setMessage(result.guaranteeId ? `Guarantee #${result.guaranteeId.toString()} created. Supabase will index it on the next sync cycle.` : "Guarantee created. Supabase will index it on the next sync cycle.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Guarantee creation failed"); }
    finally { setBusy(false); }
  }

  return (
    <section className="shell page-section narrow-page">
      <div className="page-heading">
        <p className="eyebrow">Provider setup</p><h1>Create an uptime guarantee</h1>
        <p>Terms become public contract state. The maximum liability must be fully funded in Base Sepolia test USDC before the guarantee is active.</p>
      </div>
      {!hasDeployment() ? <div className="notice">Contract deployment is still pending. The form is complete, but writes stay disabled until <code>NEXT_PUBLIC_UPTIMESURE_CONTRACT</code> is configured.</div> : null}
      <form className="form-card card" onSubmit={submit}>
        <div className="form-section"><h2>Service</h2>
          <label>HTTPS endpoint<input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.example.com/health" required /></label>
          <label>Beneficiary wallet<input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="0x…" required /></label>
        </div>
        <div className="form-grid">
          <label>Expected HTTP status<input type="number" min="100" max="599" value={expectedStatus} onChange={(e) => setExpectedStatus(Number(e.target.value))} /></label>
          <label>Expected body fragment<input value={expectedFragment} maxLength={128} onChange={(e) => setExpectedFragment(e.target.value)} placeholder="optional: ok" /></label>
          <label>Maximum latency (ms)<input type="number" min="100" max="30000" value={maxLatency} onChange={(e) => setMaxLatency(Number(e.target.value))} /></label>
          <label>Check interval (seconds)<input type="number" min="60" max="86400" value={interval} onChange={(e) => setInterval(Number(e.target.value))} /></label>
          <label>Consecutive failures<input type="number" min="1" max="10" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></label>
          <label>Minimum outage (seconds)<input type="number" min="0" max="604800" value={minOutage} onChange={(e) => setMinOutage(Number(e.target.value))} /></label>
        </div>
        <div className="form-section"><h2>Coverage</h2><div className="form-grid">
          <label>USDC per incident<input value={payout} onChange={(e) => setPayout(e.target.value)} inputMode="decimal" /></label>
          <label>Maximum payouts<input type="number" min="1" max="100" value={maxPayouts} onChange={(e) => setMaxPayouts(Number(e.target.value))} /></label>
          <label>Term (days)<input type="number" min="1" max="366" value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
          <div className="coverage-total"><span>Full liability required</span><strong>{Number(totalCoverage) / 1_000_000} test USDC</strong></div>
        </div></div>
        <div className="form-footer">
          <div><small>Contract</small><strong>{hasDeployment() ? short(CORE_ADDRESS) : "Awaiting deployment"}</strong></div>
          {connection ? <button className="button button-primary" type="submit" disabled={busy || !hasDeployment()}>{busy ? "Working…" : "Approve & create"}</button> : <button className="button button-primary" type="button" onClick={connect} disabled={busy}>{busy ? "Connecting…" : "Connect wallet"}</button>}
        </div>
      </form>
      {message ? <div className="notice">{message}{tx ? <> <a href={`${BASE_SEPOLIA_EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">View transaction</a></> : null}</div> : null}
    </section>
  );
}
