import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ConnectButton,
  useChainId,
  useClient,
  useIsConnected,
  useNativeBalance,
} from "@rialo/frost";
import {
  buildOperatorCommand,
  validateGuarantee,
  type GuaranteeDraft,
} from "./lib/guarantee";

type Deployment = {
  network: string;
  status: string;
  programId: string | null;
  deployTransaction: string | null;
  sourceCommit: string | null;
  verifiedAt: string | null;
  note?: string;
};

const initialDraft: GuaranteeDraft = {
  serviceName: "Payments API",
  endpointUrl: "https://example.com",
  expectedFragment: "Example Domain",
  beneficiary: "",
  intervalSeconds: "30",
  failureThreshold: "2",
  compensationRlo: "0.001",
  maxPayouts: "2",
};

function short(value: string | null, front = 8, back = 6) {
  if (!value) return "—";
  if (value.length <= front + back + 3) return value;
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

function NetworkPanel() {
  const client = useClient();
  const chainId = useChainId();
  const connected = useIsConnected();
  const balance = useNativeBalance();
  const [blockHeight, setBlockHeight] = useState<string>("connecting");
  const [rpcError, setRpcError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const height = await client.getBlockHeight();
        if (!cancelled) {
          setBlockHeight(height.toString());
          setRpcError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setBlockHeight("unavailable");
          setRpcError(error instanceof Error ? error.message : "RPC request failed");
        }
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client]);

  return (
    <section className="network-card" aria-label="Live Rialo DevNet connection">
      <div>
        <span className={`dot ${rpcError ? "bad" : ""}`} />
        <strong>Rialo DevNet</strong>
      </div>
      <dl>
        <div><dt>Chain</dt><dd>{chainId}</dd></div>
        <div><dt>Finalized block</dt><dd>{blockHeight}</dd></div>
        <div><dt>Wallet</dt><dd>{connected ? "connected" : "not connected"}</dd></div>
        <div><dt>Balance</dt><dd>{connected ? `${balance.formatted ?? "…"} RIA` : "—"}</dd></div>
      </dl>
      {rpcError && <p className="inline-error">Live RPC: {rpcError}</p>}
    </section>
  );
}

function App() {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [draft, setDraft] = useState<GuaranteeDraft>(initialDraft);
  const [errors, setErrors] = useState<string[]>([]);
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/deployment.json", { cache: "no-store" })
      .then((response) => response.json())
      .then((value: Deployment) => setDeployment(value))
      .catch(() => setDeployment(null));
  }, []);

  const deployed = Boolean(deployment?.programId && deployment.status === "deployed");
  const actionUrl = "https://github.com/ometere123/uptimesure/actions/workflows/create-guarantee.yml";
  const sourceUrl = "https://github.com/ometere123/uptimesure";

  const coverage = useMemo(() => {
    const amount = Number(draft.compensationRlo);
    const count = Number(draft.maxPayouts);
    if (!Number.isFinite(amount) || !Number.isFinite(count)) return "—";
    return `${(amount * count).toLocaleString(undefined, { maximumFractionDigits: 9 })} RLO`;
  }, [draft.compensationRlo, draft.maxPayouts]);

  function update<K extends keyof GuaranteeDraft>(key: K, value: GuaranteeDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setCommand(null);
    setErrors([]);
  }

  function prepare(event: FormEvent) {
    event.preventDefault();
    const nextErrors = validateGuarantee(draft);
    if (nextErrors.length) {
      setErrors(nextErrors);
      setCommand(null);
      return;
    }
    if (!deployment?.programId) {
      setErrors(["A verified Rialo DevNet program ID has not been published yet."]);
      return;
    }
    setErrors([]);
    setCommand(buildOperatorCommand(draft, deployment.programId));
  }

  async function copyCommand() {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="UptimeSure home">
          <span className="brand-mark">U</span>
          <span>UptimeSure</span>
        </a>
        <nav>
          <a href="#how">How it works</a>
          <a href="#create">Create guarantee</a>
          <a href={sourceUrl} target="_blank" rel="noreferrer">Source</a>
        </nav>
        <ConnectButton label="Connect Rialo wallet" />
      </header>

      <main id="top">
        <section className="hero">
          <div className="eyebrow">Executable service guarantees · Rialo DevNet</div>
          <h1>Put money behind your uptime promise.</h1>
          <p className="hero-copy">
            UptimeSure monitors a public API from Rialo REX, confirms repeated SLA failures,
            and can compensate the beneficiary automatically in DevNet RLO. No claim form,
            keeper bot, cron server, or custom oracle.
          </p>
          <div className="hero-actions">
            <a className="primary" href="#create">Create a guarantee</a>
            <a className="secondary" href="#proof">Inspect live proof</a>
          </div>
          <div className="truth-strip">
            <span>Real HTTPS checks</span>
            <span>Rialo workflow timers</span>
            <span>REX / TEE execution</span>
            <span>Native DevNet settlement</span>
          </div>
        </section>

        <section className="overview-grid" id="proof">
          <NetworkPanel />
          <article className="deployment-card">
            <div className="card-label">Deployment proof</div>
            <div className="deployment-status">
              <span className={`status-pill ${deployed ? "live" : "pending"}`}>{deployed ? "DEPLOYED" : "AWAITING PROOF"}</span>
              <span>{deployment?.network ?? "rialo-devnet"}</span>
            </div>
            <dl>
              <div><dt>Program</dt><dd title={deployment?.programId ?? undefined}>{short(deployment?.programId ?? null)}</dd></div>
              <div><dt>Deploy tx</dt><dd title={deployment?.deployTransaction ?? undefined}>{short(deployment?.deployTransaction ?? null)}</dd></div>
              <div><dt>Source</dt><dd>{short(deployment?.sourceCommit ?? null, 7, 0)}</dd></div>
              <div><dt>Verified</dt><dd>{deployment?.verifiedAt ?? "—"}</dd></div>
            </dl>
            {!deployed && <p className="muted">The UI deliberately shows no invented program ID or transaction proof.</p>}
          </article>
        </section>

        <section className="how" id="how">
          <div className="section-heading">
            <span className="eyebrow">One workflow, four jobs</span>
            <h2>Rialo is the monitoring infrastructure.</h2>
          </div>
          <div className="flow-grid">
            <article><span>01</span><h3>Schedule</h3><p>Venus arms the next check with an on-chain workflow timer.</p></article>
            <article><span>02</span><h3>Observe</h3><p>REX nodes request the real HTTPS endpoint and return compact health observations.</p></article>
            <article><span>03</span><h3>Confirm</h3><p>The program requires repeated failures and reduces validator results fail-closed.</p></article>
            <article><span>04</span><h3>Settle</h3><p>A confirmed incident can transfer a capped provider-funded DevNet RLO amount.</p></article>
          </div>
        </section>

        <section className="create-section" id="create">
          <div className="section-heading narrow">
            <span className="eyebrow">Provider console</span>
            <h2>Define the guarantee.</h2>
            <p>The form validates the same public policy boundaries enforced by the Rialo program.</p>
          </div>

          <div className="create-grid">
            <form className="guarantee-form" onSubmit={prepare}>
              <label>Service name<input value={draft.serviceName} onChange={(e) => update("serviceName", e.target.value)} maxLength={96} /></label>
              <label className="wide">HTTPS health endpoint<input value={draft.endpointUrl} onChange={(e) => update("endpointUrl", e.target.value)} placeholder="https://api.example.com/health" /></label>
              <label className="wide">Expected body fragment <span>optional</span><input value={draft.expectedFragment} onChange={(e) => update("expectedFragment", e.target.value)} maxLength={128} /></label>
              <label className="wide">Beneficiary Rialo pubkey<input value={draft.beneficiary} onChange={(e) => update("beneficiary", e.target.value)} placeholder="Paste beneficiary address" /></label>
              <label>Check every<input type="number" min="15" max="86400" value={draft.intervalSeconds} onChange={(e) => update("intervalSeconds", e.target.value)} /><small>seconds</small></label>
              <label>Failure threshold<input type="number" min="2" max="20" value={draft.failureThreshold} onChange={(e) => update("failureThreshold", e.target.value)} /><small>consecutive checks</small></label>
              <label>Compensation<input inputMode="decimal" value={draft.compensationRlo} onChange={(e) => update("compensationRlo", e.target.value)} /><small>RLO per incident</small></label>
              <label>Maximum payouts<input type="number" min="1" max="100" value={draft.maxPayouts} onChange={(e) => update("maxPayouts", e.target.value)} /></label>

              {errors.length > 0 && <div className="error-box">{errors.map((error) => <p key={error}>{error}</p>)}</div>}
              <button className="primary submit" type="submit" disabled={!deployed}>Prepare DevNet launch</button>
              {!deployed && <p className="form-note">Launch unlocks only after a real DevNet deployment is published.</p>}
            </form>

            <aside className="policy-card">
              <div className="card-label">Policy preview</div>
              <div className="policy-amount">{coverage}</div>
              <p>maximum configured native coverage</p>
              <hr />
              <dl>
                <div><dt>Health rule</dt><dd>HTTP 2xx{draft.expectedFragment ? " + body match" : ""}</dd></div>
                <div><dt>Breach rule</dt><dd>{draft.failureThreshold || "—"} consecutive failures</dd></div>
                <div><dt>Cadence</dt><dd>{draft.intervalSeconds || "—"} seconds</dd></div>
                <div><dt>Per incident</dt><dd>{draft.compensationRlo || "0"} RLO</dd></div>
              </dl>
              <p className="muted">DevNet RLO settlement is provider-funded. This version is not a stablecoin escrow or insurance product.</p>
            </aside>
          </div>

          {command && (
            <div className="launch-packet">
              <div>
                <div className="card-label">Real operator launch packet</div>
                <h3>Ready for Rialo DevNet</h3>
                <p>Use the repository's Ubuntu action from any Windows browser, or run this command in a supported Rialo CLI environment.</p>
              </div>
              <pre>{command}</pre>
              <div className="packet-actions">
                <button className="secondary" type="button" onClick={copyCommand}>{copied ? "Copied" : "Copy command"}</button>
                <a className="primary" href={actionUrl} target="_blank" rel="noreferrer">Open GitHub launch action</a>
              </div>
            </div>
          )}
        </section>

        <section className="principles">
          <div><strong>No fake uptime data.</strong><span>Observations come from actual REX HTTPS requests.</span></div>
          <div><strong>No backend scheduler.</strong><span>Rialo owns the recurring workflow cadence.</span></div>
          <div><strong>No silent settlement claim.</strong><span>The dashboard publishes IDs only after verifiable DevNet proof exists.</span></div>
        </section>
      </main>

      <footer>
        <span>UptimeSure · Rialo DevNet</span>
        <span>Experimental software. Not production insurance or a custody product.</span>
      </footer>
    </div>
  );
}

export default App;
