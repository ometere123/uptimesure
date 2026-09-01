"use client";

"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { connectWallet, createGuarantee, type FlowStage, publicClient, WalletConnection } from "@/lib/chain";
import { BASE_SEPOLIA_EXPLORER, CORE_ADDRESS, hasDeployment, USDC_ADDRESS } from "@/lib/config";
import { erc20Abi } from "@/lib/abi";
import { short, usdc } from "@/lib/format";
import {
  fullLiability,
  formatUsdcInput,
  type GuaranteeFormValues,
  minimumOutageFor,
  parseUsdc,
  validateGuaranteeForm,
} from "@/lib/policy";

const STAGE_TEXT: Record<FlowStage, string> = {
  "checking-allowance": "Reading your current USDC allowance…",
  "awaiting-approval-signature": "Approve the USDC spend in your wallet.",
  "confirming-approval": "Waiting for the approval to confirm on Base Sepolia…",
  "awaiting-signature": "Confirm the guarantee transaction in your wallet.",
  confirming: "Waiting for the guarantee transaction to confirm on Base Sepolia…",
  done: "Confirmed.",
};

const INITIAL: GuaranteeFormValues = {
  beneficiary: "",
  endpointUrl: "",
  expectedStatus: 200,
  expectedFragment: "",
  maxLatencyMs: 2000,
  checkIntervalSecs: 300,
  failureThreshold: 3,
  minOutageSecs: 600,
  payoutPerIncident: "25",
  maxPayouts: 4,
  termDays: 30,
  coverageAmount: "100",
};

interface Created {
  guaranteeId?: bigint;
  createHash: `0x${string}`;
  approvalHash?: `0x${string}`;
}

export default function CreatePage() {
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [values, setValues] = useState<GuaranteeFormValues>(INITIAL);
  const [errors, setErrors] = useState<Partial<Record<keyof GuaranteeFormValues, string>>>({});
  const [stage, setStage] = useState<FlowStage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [preflight, setPreflight] = useState<string | null>(null);
  const busy = (stage !== null && stage !== "done") || preflight !== null;

  const set = useCallback(<K extends keyof GuaranteeFormValues>(key: K, value: GuaranteeFormValues[K]) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  // Real balance read from the chain. Shown so a provider learns they are short of funds before signing rather
  // than from a revert; never a placeholder number when the read fails.
  useEffect(() => {
    if (!connection) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    publicClient
      .readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [connection.address] })
      .then((value) => {
        if (!cancelled) setBalance(value);
      })
      .catch(() => {
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // The contract's own minimum-coverage expression, shown live so the number in the coverage field can be
  // compared against it before signing rather than after a revert.
  const liability = useMemo(() => {
    const payout = parseUsdc(values.payoutPerIncident);
    if (!("value" in payout) || !Number.isInteger(values.maxPayouts) || values.maxPayouts < 1) return null;
    return fullLiability(payout.value, values.maxPayouts);
  }, [values.payoutPerIncident, values.maxPayouts]);

  const requiredOutage = minimumOutageFor(values.checkIntervalSecs, values.failureThreshold);
  const coverageParsed = parseUsdc(values.coverageAmount);
  const coverage = "value" in coverageParsed ? coverageParsed.value : null;
  const shortfall = balance !== null && coverage !== null && coverage > balance ? { balance, coverage } : null;

  async function connect() {
    setFailure(null);
    setStage("checking-allowance");
    try {
      setConnection(await connectWallet());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Wallet connection failed.");
    } finally {
      setStage(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setCreated(null);

    if (!connection) {
      setFailure("Connect a wallet first.");
      return;
    }
    if (!hasDeployment()) {
      setFailure("The Base Sepolia contract address is not configured, so no guarantee can be created yet.");
      return;
    }

    // Checked against the same bounds the contract enforces, so a rejected policy costs no gas.
    const validation = validateGuaranteeForm(values, Math.floor(Date.now() / 1000));
    if (!validation.ok) {
      const mapped: Partial<Record<keyof GuaranteeFormValues, string>> = {};
      for (const error of validation.errors) mapped[error.field] ??= error.message;
      setErrors(mapped);
      setFailure(`${validation.errors.length} field${validation.errors.length === 1 ? "" : "s"} need attention.`);
      return;
    }
    setErrors({});

    setPreflight("Checking HTTPS target policy and DNS answers…");
    try {
      const response = await fetch("/api/preflight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: values.endpointUrl.trim() }) });
      const result = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !result.ok) {
        setPreflight(null);
        setFailure(`Monitor preflight refused this endpoint (${result.error ?? "PREFLIGHT_FAILED"}).`);
        return;
      }
    } catch {
      setPreflight(null);
      setFailure("Monitor preflight could not verify DNS. Guarantee creation is blocked until it succeeds.");
      return;
    }
    setPreflight(null);

    try {
      const result = await createGuarantee(connection, {
        beneficiary: values.beneficiary.trim() as `0x${string}`,
        endpointUrl: values.endpointUrl.trim(),
        expectedStatus: values.expectedStatus,
        expectedFragment: values.expectedFragment.trim(),
        maxLatencyMs: values.maxLatencyMs,
        checkIntervalSecs: values.checkIntervalSecs,
        failureThreshold: values.failureThreshold,
        minOutageSecs: values.minOutageSecs,
        payoutPerIncident: validation.payout,
        maxPayouts: values.maxPayouts,
        expiresAt: validation.expiresAt,
        coverageAmount: validation.coverage,
      }, setStage);
      setCreated(result);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Guarantee creation failed.");
    } finally {
      setStage(null);
    }
  }

  return (
    <section className="shell page-section narrow-page">
      <div className="page-heading">
        <p className="eyebrow">Provider setup</p>
        <h1>Create an uptime guarantee</h1>
        <p>
          These terms become public contract state on Base Sepolia. The full liability — every incident the
          guarantee promises to pay — must be funded in test USDC before the guarantee becomes active.
        </p>
      </div>

      {!hasDeployment() ? (
        <div className="notice notice-error">
          No contract address is configured for this deployment, so guarantees cannot be created. Set
          <code> NEXT_PUBLIC_UPTIMESURE_CONTRACT</code> to the deployed UptimeSureCore address.
        </div>
      ) : null}

      <form className="form-card card" onSubmit={submit} noValidate>
        <div className="form-section">
          <h2>Service</h2>
          <label>
            HTTPS endpoint
            <input
              value={values.endpointUrl}
              onChange={(e) => set("endpointUrl", e.target.value)}
              className={errors.endpointUrl ? "input-invalid" : undefined}
              placeholder="https://api.example.com/health"
              autoComplete="off"
              spellCheck={false}
            />
            {errors.endpointUrl ? <small className="field-error">{errors.endpointUrl}</small> : (
              <small className="form-hint">
                Must be public and reachable over HTTPS. Private, loopback and metadata addresses are refused by
                the monitor.
              </small>
            )}
          </label>
          <label>
            Beneficiary wallet
            <input
              value={values.beneficiary}
              onChange={(e) => set("beneficiary", e.target.value)}
              className={errors.beneficiary ? "input-invalid" : undefined}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
            />
            {errors.beneficiary ? <small className="field-error">{errors.beneficiary}</small> : (
              <small className="form-hint">
                Fixed at creation. Compensation can only ever be sent here — not even the monitor can redirect it.
              </small>
            )}
          </label>
        </div>

        <div className="form-section">
          <h2>Health criteria</h2>
          <div className="form-grid">
            <label>
              Expected HTTP status
              <input
                type="number"
                min={100}
                max={599}
                value={values.expectedStatus}
                onChange={(e) => set("expectedStatus", Number(e.target.value))}
                className={errors.expectedStatus ? "input-invalid" : undefined}
              />
              {errors.expectedStatus ? <small className="field-error">{errors.expectedStatus}</small> : null}
            </label>
            <label>
              Expected body fragment
              <input
                value={values.expectedFragment}
                maxLength={128}
                onChange={(e) => set("expectedFragment", e.target.value)}
                className={errors.expectedFragment ? "input-invalid" : undefined}
                placeholder="optional, e.g. ok"
              />
              {errors.expectedFragment ? <small className="field-error">{errors.expectedFragment}</small> : (
                <small className="form-hint">Leave empty to check status and latency only.</small>
              )}
            </label>
            <label>
              Maximum completed-response latency (ms)
              <input
                type="number"
                min={100}
                max={30_000}
                value={values.maxLatencyMs}
                onChange={(e) => set("maxLatencyMs", Number(e.target.value))}
                className={errors.maxLatencyMs ? "input-invalid" : undefined}
              />
              {errors.maxLatencyMs ? <small className="field-error">{errors.maxLatencyMs}</small> : null}
            </label>
            <label>
              Check cadence (seconds)
              <input
                type="number"
                min={60}
                max={86_400}
                value={values.checkIntervalSecs}
                onChange={(e) => set("checkIntervalSecs", Number(e.target.value))}
                className={errors.checkIntervalSecs ? "input-invalid" : undefined}
              />
              {errors.checkIntervalSecs ? <small className="field-error">{errors.checkIntervalSecs}</small> : null}
            </label>
            <label>
              Consecutive failures before an incident
              <input
                type="number"
                min={1}
                max={10}
                value={values.failureThreshold}
                onChange={(e) => set("failureThreshold", Number(e.target.value))}
                className={errors.failureThreshold ? "input-invalid" : undefined}
              />
              {errors.failureThreshold ? <small className="field-error">{errors.failureThreshold}</small> : null}
            </label>
            <label>
              Minimum outage (seconds)
              <input
                type="number"
                min={0}
                max={604_800}
                value={values.minOutageSecs}
                onChange={(e) => set("minOutageSecs", Number(e.target.value))}
                className={errors.minOutageSecs ? "input-invalid" : undefined}
              />
              {errors.minOutageSecs ? <small className="field-error">{errors.minOutageSecs}</small> : (
                <small className="form-hint">
                  At least {requiredOutage}s for this cadence and threshold.
                </small>
              )}
            </label>
          </div>
        </div>

        <div className="form-section">
          <h2>Coverage</h2>
          <div className="form-grid">
            <label>
              Test USDC per incident
              <input
                value={values.payoutPerIncident}
                onChange={(e) => set("payoutPerIncident", e.target.value)}
                className={errors.payoutPerIncident ? "input-invalid" : undefined}
                inputMode="decimal"
                autoComplete="off"
              />
              {errors.payoutPerIncident ? <small className="field-error">{errors.payoutPerIncident}</small> : null}
            </label>
            <label>
              Maximum incidents
              <input
                type="number"
                min={1}
                max={100}
                value={values.maxPayouts}
                onChange={(e) => set("maxPayouts", Number(e.target.value))}
                className={errors.maxPayouts ? "input-invalid" : undefined}
              />
              {errors.maxPayouts ? <small className="field-error">{errors.maxPayouts}</small> : null}
            </label>
            <label>
              Term (days)
              <input
                type="number"
                min={1}
                max={366}
                value={values.termDays}
                onChange={(e) => set("termDays", Number(e.target.value))}
                className={errors.termDays ? "input-invalid" : undefined}
              />
              {errors.termDays ? <small className="field-error">{errors.termDays}</small> : (
                <small className="form-hint">
                  Expires {new Date(Date.now() + values.termDays * 86_400_000).toLocaleDateString()}.
                </small>
              )}
            </label>
            <label>
              Total funded coverage (test USDC)
              <input
                value={values.coverageAmount}
                onChange={(e) => set("coverageAmount", e.target.value)}
                className={errors.coverageAmount ? "input-invalid" : undefined}
                inputMode="decimal"
                autoComplete="off"
              />
              {errors.coverageAmount ? <small className="field-error">{errors.coverageAmount}</small> : (
                <small className="form-hint">
                  Deposited now, and top-ups are allowed later.{" "}
                  {liability === null || coverage === liability ? null : (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => set("coverageAmount", formatUsdcInput(liability))}
                    >
                      Use the minimum
                    </button>
                  )}
                </small>
              )}
            </label>
          </div>
          <div className="coverage-total" style={{ marginTop: 16 }}>
            <span>Minimum coverage the contract will accept</span>
            <strong>{liability === null ? "—" : usdc(liability)}</strong>
            {liability === null ? null : (
              <small className="form-hint">
                {values.maxPayouts} incident{values.maxPayouts === 1 ? "" : "s"} × {values.payoutPerIncident.trim()}{" "}
                test USDC. Funding more than this leaves room for later top-ups without a second deposit.
              </small>
            )}
          </div>
        </div>

        <div className="form-footer">
          <div>
            <small>Settlement contract</small>
            <strong>{hasDeployment() ? short(CORE_ADDRESS) : "Not configured"}</strong>
            {connection ? (
              <small>
                {balance === null
                  ? "Test USDC balance unavailable"
                  : `Wallet holds ${usdc(balance)}`}
              </small>
            ) : null}
          </div>
          {connection ? (
            <button className="button button-primary" type="submit" disabled={busy || !hasDeployment()}>
              {busy ? "Working…" : "Approve & create guarantee"}
            </button>
          ) : (
            <button className="button button-primary" type="button" onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </form>

      {shortfall && !busy ? (
        <div className="notice">
          This wallet holds {usdc(shortfall.balance)} but the guarantee funds {usdc(shortfall.coverage)}. Base
          Sepolia test USDC can be requested from{" "}
          <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Circle&rsquo;s testnet faucet</a>.
        </div>
      ) : null}

      {stage && stage !== "done" ? <div className="notice">{STAGE_TEXT[stage]}</div> : null}
      {preflight ? <div className="notice">{preflight}</div> : null}
      {failure ? <div className="notice notice-error">{failure}</div> : null}

      {created ? (
        <div className="notice">
          <strong>
            {created.guaranteeId !== undefined
              ? `Guarantee #${created.guaranteeId.toString()} is live onchain.`
              : "Guarantee created onchain."}
          </strong>
          <div className="tx-list">
            {created.approvalHash ? (
              <span>
                USDC approval{" "}
                <a href={`${BASE_SEPOLIA_EXPLORER}/tx/${created.approvalHash}`} target="_blank" rel="noreferrer">
                  {short(created.approvalHash, 10, 8)}
                </a>
              </span>
            ) : (
              <span>USDC approval not needed — the existing allowance already covered it.</span>
            )}
            <span>
              Guarantee transaction{" "}
              <a href={`${BASE_SEPOLIA_EXPLORER}/tx/${created.createHash}`} target="_blank" rel="noreferrer">
                {short(created.createHash, 10, 8)}
              </a>
            </span>
            {created.guaranteeId !== undefined ? (
              <span>
                <Link href={`/guarantees/${created.guaranteeId.toString()}`}>Open the guarantee page →</Link>
              </span>
            ) : null}
          </div>
          <small className="form-hint">
            Monitoring begins on the next scheduled check. The indexer adds it to the public list once the
            creation block is final.
          </small>
        </div>
      ) : null}
    </section>
  );
}
