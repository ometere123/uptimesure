"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { BASE_SEPOLIA_EXPLORER, hasDeployment } from "@/lib/config";
import {
  connectWallet,
  type FlowStage,
  topUpGuarantee,
  withdrawExpiredGuarantee,
  WalletConnection,
} from "@/lib/chain";
import { guaranteeStatus, relativeDate, short, usdc } from "@/lib/format";
import {
  divergences,
  type OnchainGuaranteeState,
  type OnchainIncident,
  readGuaranteeState,
  readIncident,
  withdrawableAt,
} from "@/lib/onchain";
import { parseUsdc } from "@/lib/policy";
import { getSupabase } from "@/lib/supabase";
import { GuaranteeRow, IncidentRow, ObservationChainStatus, ObservationRow } from "@/lib/types";

/** How each chain status reads to someone who did not write the monitor. */
const CHAIN_STATUS_TEXT: Record<ObservationChainStatus, string> = {
  pending: "not yet submitted",
  submitted: "submitted, awaiting receipt",
  confirmed: "settled onchain",
  failed: "submission failed",
  indexed: "settled onchain",
  not_required: "evidence only",
  unmonitorable: "refused by policy",
};

/**
 * A refusal is not an outage.
 *
 * The monitor stores a policy-refused target with `healthy = false` because the column is not nullable, and a
 * database constraint ties the two together. Rendering that as "Failure" would tell a provider their service went
 * down when in fact it was never probed — the exact confusion the schema was changed to prevent.
 */
function observationVerdict(observation: ObservationRow): "Healthy" | "Failure" | "Refused" {
  if (observation.tx_status === "unmonitorable") return "Refused";
  return observation.healthy ? "Healthy" : "Failure";
}

export default function GuaranteeDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [indexed, setIndexed] = useState<GuaranteeRow | null>(null);
  const [observations, setObservations] = useState<ObservationRow[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [onchain, setOnchain] = useState<OnchainGuaranteeState | null>(null);
  const [onchainError, setOnchainError] = useState<string | null>(null);
  const [openIncident, setOpenIncident] = useState<OnchainIncident | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [topUpAmount, setTopUpAmount] = useState("25");
  const [stage, setStage] = useState<FlowStage | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionTx, setActionTx] = useState<string | null>(null);

  const validId = Number.isSafeInteger(id) && id > 0;

  const loadIndexed = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) {
      setError("Supabase is not configured, so the evidence stream cannot be shown.");
      return;
    }
    const [guarantee, observationRows, incidentRows] = await Promise.all([
      supabase.from("guarantees").select("*").eq("id", id).maybeSingle(),
      supabase.from("observations").select("*").eq("guarantee_id", id)
        .order("observed_at", { ascending: false }).limit(50),
      supabase.from("incidents").select("*").eq("guarantee_id", id)
        .order("confirmed_at", { ascending: false }).limit(20),
    ]);
    if (guarantee.error) setError(guarantee.error.message);
    else setIndexed((guarantee.data as GuaranteeRow | null) ?? null);
    setObservations((observationRows.data || []) as ObservationRow[]);
    setIncidents((incidentRows.data || []) as IncidentRow[]);
  }, [id]);

  // The contract read and the index read are independent on purpose: either can succeed alone, and the page is
  // still useful (and honest about what is missing) when only one does.
  const loadChain = useCallback(async () => {
    if (!hasDeployment()) {
      setOnchainError("No contract address is configured, so live contract state is unavailable.");
      return;
    }
    try {
      const state = await readGuaranteeState(BigInt(id));
      setOnchain(state);
      setOnchainError(state === null ? "This guarantee id has not been issued by the contract." : null);
      setOpenIncident(state && state.activeIncidentId !== 0n ? await readIncident(state.activeIncidentId) : null);
    } catch (e) {
      setOnchain(null);
      setOnchainError(e instanceof Error ? `Base Sepolia read failed: ${e.message}` : "Base Sepolia read failed.");
    }
  }, [id]);

  useEffect(() => {
    if (!validId) {
      setError("That is not a valid guarantee id.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    Promise.all([loadIndexed(), loadChain()]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [validId, loadIndexed, loadChain]);

  async function connectProvider() {
    setActionBusy(true);
    setActionMessage(null);
    setActionTx(null);
    try {
      const next = await connectWallet();
      setConnection(next);
      const provider = onchain?.guarantee.provider ?? indexed?.provider;
      if (provider && next.address.toLowerCase() !== provider.toLowerCase()) {
        setActionMessage("This wallet is not the provider. Management actions would be rejected by the contract.");
      }
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Wallet connection failed.");
    } finally {
      setActionBusy(false);
    }
  }

  async function runAction(label: string, action: () => Promise<`0x${string}`>) {
    setActionBusy(true);
    setActionMessage(null);
    setActionTx(null);
    try {
      const hash = await action();
      setActionTx(hash);
      setActionMessage(`${label} confirmed on Base Sepolia.`);
      await Promise.all([loadChain(), loadIndexed()]);
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : `${label} failed.`);
    } finally {
      setStage(null);
      setActionBusy(false);
    }
  }

  function topUp() {
    if (!connection) return;
    const parsed = parseUsdc(topUpAmount);
    if ("error" in parsed) {
      setActionMessage(parsed.error);
      setActionTx(null);
      return;
    }
    void runAction(
      "Coverage top-up",
      () => topUpGuarantee(connection, BigInt(id), parsed.value, setStage).then((r) => r.topUpHash),
    );
  }

  function withdraw() {
    if (!connection) return;
    void runAction("Coverage withdrawal", () => withdrawExpiredGuarantee(connection, BigInt(id), setStage));
  }

  if (loading) {
    return (
      <section className="shell page-section">
        <div className="loading-card card">Reading contract state and evidence…</div>
      </section>
    );
  }

  // Nothing to show only when both sources came up empty. If the chain has it and the index does not, the page
  // still renders from the contract — a guarantee is real the moment it is onchain, not when the indexer notices.
  if (!indexed && !onchain) {
    return (
      <section className="shell page-section">
        <EmptyState title="Guarantee unavailable" body={error || onchainError || "No such guarantee."} />
      </section>
    );
  }

  const chain = onchain?.guarantee ?? null;
  const provider = chain?.provider ?? indexed?.provider ?? "";
  const beneficiary = chain?.beneficiary ?? indexed?.beneficiary ?? "";
  const endpoint = chain?.endpointUrl ?? indexed?.endpoint_url ?? "";
  const criteriaHash = chain?.criteriaHash ?? indexed?.criteria_hash ?? "";
  const expiresAtSeconds = chain
    ? Number(chain.expiresAt)
    : Math.floor(new Date(indexed!.expires_at).getTime() / 1000);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const withdrawOpensAt = withdrawableAt(expiresAtSeconds, Number(onchain?.settlementWindowSecs ?? 1800n));

  const status = chain
    ? guaranteeStatus(chain.active, chain.withdrawn, new Date(Number(chain.expiresAt) * 1000).toISOString())
    : guaranteeStatus(indexed!.active, indexed!.withdrawn, indexed!.expires_at);

  const drift = chain && indexed ? divergences(chain, indexed) : [];
  const connectedProvider = Boolean(connection && provider &&
    connection.address.toLowerCase() === provider.toLowerCase());
  const canTopUp = connectedProvider && chain !== null && chain.active && !chain.withdrawn &&
    nowSeconds <= expiresAtSeconds && !onchain?.paused;
  const canWithdraw = connectedProvider && chain !== null && !chain.withdrawn &&
    nowSeconds >= withdrawOpensAt && !onchain?.paused;

  return (
    <section className="shell page-section">
      <div className="page-heading row-between">
        <div>
          <p className="eyebrow">Guarantee #{id}</p>
          <h1>{endpoint}</h1>
          <p>
            Criteria hash <code>{short(criteriaHash, 12, 10)}</code>
          </p>
        </div>
        <StatusPill status={status} />
      </div>

      {onchainError ? <div className="notice notice-error">{onchainError}</div> : null}
      {onchain?.paused ? (
        <div className="notice notice-error">
          The settlement contract is paused by its admin. Observations cannot be recorded and coverage cannot move
          until it is unpaused.
        </div>
      ) : null}
      {chain && !indexed ? (
        <div className="notice">
          This guarantee is live onchain but the indexer has not recorded it yet, so no evidence history is shown
          below. Everything above comes from a direct contract read.
        </div>
      ) : null}
      {drift.length > 0 ? (
        <div className="notice notice-error">
          <strong>The indexed copy disagrees with the contract.</strong> The contract is authoritative; the values
          shown are its own. Divergence: {drift.join("; ")}.
        </div>
      ) : null}

      <div className="metric-grid metric-grid-four">
        <div className="metric card">
          <span>Coverage remaining{chain ? "" : " (indexed)"}</span>
          <strong>{usdc(chain ? chain.remainingCoverage : indexed!.remaining_coverage)}</strong>
        </div>
        <div className="metric card">
          <span>Payout per incident</span>
          <strong>{usdc(chain ? chain.payoutPerIncident : indexed!.payout_per_incident)}</strong>
        </div>
        <div className="metric card">
          <span>Failure state</span>
          <strong>
            {chain ? chain.consecutiveFailures : indexed!.consecutive_failures}/
            {chain ? chain.failureThreshold : indexed!.failure_threshold}
          </strong>
        </div>
        <div className="metric card">
          <span>Paid incidents</span>
          <strong>
            {chain ? chain.paidPayouts : indexed!.paid_payouts}/{chain ? chain.maxPayouts : indexed!.max_payouts}
          </strong>
        </div>
      </div>

      <div className="detail-grid">
        <article className="card detail-card">
          <p className="eyebrow">Monitoring policy</p>
          <dl>
            <div><dt>HTTP status</dt><dd>{chain ? chain.expectedStatus : indexed!.expected_status}</dd></div>
            <div>
              <dt>Body fragment</dt>
              <dd>{(chain ? chain.expectedFragment : indexed!.expected_fragment) || "Not required"}</dd>
            </div>
            <div><dt>Max latency</dt><dd>{chain ? chain.maxLatencyMs : indexed!.max_latency_ms} ms</dd></div>
            <div><dt>Interval</dt><dd>{chain ? chain.checkIntervalSecs : indexed!.check_interval_seconds}s</dd></div>
            <div>
              <dt>Failure threshold</dt>
              <dd>{chain ? chain.failureThreshold : indexed!.failure_threshold} consecutive</dd>
            </div>
            <div><dt>Minimum outage</dt><dd>{chain ? chain.minOutageSecs : indexed!.min_outage_seconds}s</dd></div>
            <div>
              <dt>Last observation</dt>
              <dd>
                {chain
                  ? (chain.lastObservedAt === 0n
                    ? "Never"
                    : relativeDate(new Date(Number(chain.lastObservedAt) * 1000).toISOString()))
                  : relativeDate(indexed!.last_observed_at)}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{relativeDate(new Date(expiresAtSeconds * 1000).toISOString())}</dd>
            </div>
          </dl>
          <p className="card-note">
            {chain
              ? "Read directly from the settlement contract on Base Sepolia."
              : "From the indexed copy — the contract could not be read."}
          </p>
        </article>
        <article className="card detail-card">
          <p className="eyebrow">Parties</p>
          <dl>
            <div>
              <dt>Provider</dt>
              <dd>
                <a href={`${BASE_SEPOLIA_EXPLORER}/address/${provider}`} target="_blank" rel="noreferrer">
                  {short(provider)}
                </a>
              </dd>
            </div>
            <div>
              <dt>Beneficiary</dt>
              <dd>
                <a href={`${BASE_SEPOLIA_EXPLORER}/address/${beneficiary}`} target="_blank" rel="noreferrer">
                  {short(beneficiary)}
                </a>
              </dd>
            </div>
            {indexed ? (
              <div>
                <dt>Contract</dt>
                <dd>
                  <a
                    href={`${BASE_SEPOLIA_EXPLORER}/address/${indexed.contract_address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(indexed.contract_address)}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="card-note">
            The beneficiary is fixed at creation. The monitor role can record observations and nothing else — it
            cannot change these addresses, alter the payout, or redirect compensation.
          </p>
        </article>
      </div>

      {openIncident ? (
        <div className="notice notice-error">
          <strong>Incident #{onchain!.activeIncidentId.toString()} is open onchain.</strong> Confirmed{" "}
          {relativeDate(new Date(Number(openIncident.confirmedAt) * 1000).toISOString())} and{" "}
          {usdc(openIncident.payoutAmount)} has been paid to the beneficiary. Recovery is recorded when the
          endpoint next passes its criteria.
        </div>
      ) : null}

      <div className="section-subheading">
        <div>
          <p className="eyebrow">Provider controls</p>
          <h2>Manage coverage</h2>
        </div>
        <span>{connection ? `Wallet ${short(connection.address)}` : "Provider wallet required"}</span>
      </div>
      <div className="manage-card card">
        {!connection ? (
          <div className="manage-copy">
            <div>
              <strong>Provider-only contract actions</strong>
              <p>
                Connect the provider wallet to add test-USDC coverage, or to reclaim unused coverage once the term
                and its settlement window have elapsed.
              </p>
            </div>
            <button className="button button-secondary" onClick={connectProvider} disabled={actionBusy}>
              {actionBusy ? "Connecting…" : "Connect provider"}
            </button>
          </div>
        ) : (
          <>
            <div className="manage-copy">
              <div>
                <strong>{connectedProvider ? "Provider verified" : "Different wallet connected"}</strong>
                <p>
                  {connectedProvider
                    ? "Every action is still authorised by the contract itself, not by this page."
                    : `Switch to ${short(provider)} before submitting a management transaction.`}
                </p>
              </div>
              <button
                className="button button-ghost button-small"
                onClick={connectProvider}
                disabled={actionBusy}
              >
                Change wallet
              </button>
            </div>
            <div className="manage-actions">
              <label>
                Extra coverage (test USDC)
                <input
                  value={topUpAmount}
                  onChange={(e) => setTopUpAmount(e.target.value)}
                  inputMode="decimal"
                  disabled={!canTopUp || actionBusy}
                />
              </label>
              <button
                className="button button-secondary"
                type="button"
                onClick={topUp}
                disabled={!canTopUp || actionBusy}
              >
                {actionBusy ? "Working…" : "Top up coverage"}
              </button>
              <button
                className="button button-primary"
                type="button"
                onClick={withdraw}
                disabled={!canWithdraw || actionBusy}
              >
                {actionBusy ? "Working…" : "Withdraw expired coverage"}
              </button>
            </div>
            {connectedProvider && !canWithdraw && chain && !chain.withdrawn && nowSeconds < withdrawOpensAt ? (
              <p className="card-note">
                Coverage can be reclaimed from{" "}
                {new Date(withdrawOpensAt * 1000).toLocaleString()} — the contract holds it for a{" "}
                {Number(onchain?.settlementWindowSecs ?? 1800n) / 60}-minute settlement window after expiry so a
                late outage can still be paid.
              </p>
            ) : null}
          </>
        )}
        {stage && stage !== "done" ? <div className="notice">{stage.replace(/-/g, " ")}…</div> : null}
        {actionMessage ? (
          <div className="notice">
            {actionMessage}
            {actionTx ? (
              <>
                {" "}
                <a href={`${BASE_SEPOLIA_EXPLORER}/tx/${actionTx}`} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="section-subheading">
        <div>
          <p className="eyebrow">Evidence stream</p>
          <h2>Recent observations</h2>
        </div>
        <span>{observations.length} loaded</span>
      </div>
      {observations.length === 0 ? (
        <EmptyState
          title="No observations indexed yet"
          body="Each scheduled check appears here with its evidence hash once the monitor has run."
        />
      ) : (
        <div className="table-card card">
          <div className="table-row observation-row table-head">
            <span>Observed</span>
            <span>Result</span>
            <span>HTTP</span>
            <span>Latency</span>
            <span>Evidence hash</span>
            <span>Chain</span>
          </div>
          {observations.map((o) => (
            <div className="table-row observation-row" key={o.observation_id}>
              <span>{relativeDate(o.observed_at)}</span>
              <span><StatusPill status={observationVerdict(o)} /></span>
              <span>{o.http_status ?? "—"}</span>
              <span>{o.latency_ms == null ? "—" : `${o.latency_ms}ms`}</span>
              <span><code title={o.evidence_hash}>{short(o.evidence_hash, 10, 6)}</code></span>
              <span>
                {o.tx_hash ? (
                  <a href={`${BASE_SEPOLIA_EXPLORER}/tx/${o.tx_hash}`} target="_blank" rel="noreferrer">
                    {short(o.tx_hash)}
                  </a>
                ) : (
                  CHAIN_STATUS_TEXT[o.tx_status] ?? o.tx_status
                )}
                {o.error_code ? <small className="row-note">{o.error_code}</small> : null}
                {o.chain_error ? <small className="row-note">{o.chain_error}</small> : null}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="section-subheading">
        <div>
          <p className="eyebrow">Settlement history</p>
          <h2>Incidents</h2>
        </div>
        <span>{incidents.length} loaded</span>
      </div>
      {incidents.length === 0 ? (
        <EmptyState
          title="No confirmed incidents"
          body="An incident is confirmed only once the consecutive-failure threshold and the minimum outage duration have both been satisfied."
        />
      ) : (
        <div className="cards-list">
          {incidents.map((i) => (
            <article className="incident-card card" key={i.id}>
              <div>
                <p className="eyebrow">Incident #{i.id}</p>
                <h3>{i.recovered_at ? "Recovered" : "Active outage"}</h3>
                <p>
                  Started {relativeDate(i.started_at)} · confirmed {relativeDate(i.confirmed_at)}
                </p>
                <p className="card-note">
                  Confirm evidence <code title={i.confirm_evidence_hash}>{short(i.confirm_evidence_hash, 10, 6)}</code>
                  {i.recovery_evidence_hash ? (
                    <>
                      {" · recovery evidence "}
                      <code title={i.recovery_evidence_hash}>{short(i.recovery_evidence_hash, 10, 6)}</code>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="guarantee-card-side">
                <strong>{usdc(i.payout_amount)}</strong>
                <small>{i.recovered_at ? `Recovered ${relativeDate(i.recovered_at)}` : "Awaiting recovery"}</small>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
