import Link from "next/link";
import { BASE_SEPOLIA_EXPLORER, USDC_ADDRESS, hasDeployment } from "@/lib/config";
import { short } from "@/lib/format";

export default function Home() {
  return (
    <>
      <section className="hero shell">
        <div className="hero-copy">
          <p className="eyebrow">Executable uptime guarantees</p>
          <h1>Put money behind your uptime promise.</h1>
          <p className="hero-lede">UptimeSure lets service providers fully fund a testnet guarantee, monitor a real HTTPS endpoint, and compensate a fixed beneficiary when deterministic SLA conditions are breached.</p>
          <div className="hero-actions">
            <Link href="/create" className="button button-primary">Create guarantee</Link>
            <Link href="/guarantees" className="button button-secondary">Explore guarantees</Link>
          </div>
          <p className="microcopy">No AI decides payouts. No mock uptime data. Contract rules cap every payout.</p>
        </div>
        <div className="hero-proof card">
          <div className="proof-row"><span>Settlement</span><strong>Base Sepolia</strong></div>
          <div className="proof-row"><span>Coverage asset</span><strong>Circle test USDC</strong></div>
          <div className="proof-row"><span>Monitoring</span><strong>Supabase Cron + Edge Functions</strong></div>
          <div className="proof-row"><span>Contract</span><strong>{hasDeployment() ? "Configured" : "Awaiting deployment"}</strong></div>
          <div className="proof-row"><span>USDC</span><a href={`${BASE_SEPOLIA_EXPLORER}/address/${USDC_ADDRESS}`} target="_blank" rel="noreferrer">{short(USDC_ADDRESS)}</a></div>
        </div>
      </section>

      <section className="shell section">
        <div className="section-heading">
          <p className="eyebrow">How it works</p>
          <h2>An SLA that settles itself.</h2>
          <p>Every critical term is explicit. The monitor can report observations, but it cannot change the beneficiary or move funds anywhere else.</p>
        </div>
        <div className="steps-grid">
          <article className="step card"><span>01</span><h3>Fund the promise</h3><p>The provider escrows enough test USDC to cover the full maximum liability before protection starts.</p></article>
          <article className="step card"><span>02</span><h3>Probe the endpoint</h3><p>Supabase Cron invokes a bounded Edge Function that checks HTTPS status, response content and latency.</p></article>
          <article className="step card"><span>03</span><h3>Apply fixed rules</h3><p>Consecutive failures, minimum outage duration, observation spacing and duplicate guards are enforced by the contract.</p></article>
          <article className="step card"><span>04</span><h3>Compensate</h3><p>When the configured breach threshold is reached, the contract pays the fixed beneficiary and records the incident onchain.</p></article>
        </div>
      </section>

      <section className="shell section split-section">
        <div>
          <p className="eyebrow">Designed for real infrastructure</p>
          <h2>APIs, RPCs, webhooks and agent services.</h2>
        </div>
        <div className="principles card">
          <div><strong>Deterministic</strong><p>HTTP status, latency, body fragment, failure count and outage duration.</p></div>
          <div><strong>Bounded authority</strong><p>The monitoring key can only submit observations. It never custodies coverage.</p></div>
          <div><strong>Verifiable</strong><p>Evidence hashes, observations, incidents and payout transactions remain inspectable.</p></div>
          <div><strong>Rialo-ready</strong><p>The monitoring/scheduling layer can later migrate to Rialo Workflow + REX without changing the product model.</p></div>
        </div>
      </section>
    </>
  );
}
