"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusPill";
import { coreAbi } from "@/lib/abi";
import { publicClient } from "@/lib/chain";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_EXPLORER,
  CORE_ADDRESS,
  hasDeployment,
  USDC_ADDRESS,
} from "@/lib/config";
import { relativeDate, short } from "@/lib/format";
import { getSupabase } from "@/lib/supabase";
import type { ChainSyncRow, ObservationChainStatus } from "@/lib/types";

type Probe = "checking" | "ok" | "unconfigured" | "error";

interface ChainState {
  block: bigint;
  coverageToken: `0x${string}` | null;
  nextGuaranteeId: bigint | null;
  paused: boolean | null;
}

interface IndexState {
  guarantees: number;
  sync: ChainSyncRow | null;
  latestObservation: { observed_at: string; healthy: boolean; tx_status: ObservationChainStatus } | null;
}

export default function StatusPage() {
  const [chainProbe, setChainProbe] = useState<Probe>("checking");
  const [chain, setChain] = useState<ChainState | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [indexProbe, setIndexProbe] = useState<Probe>("checking");
  const [index, setIndex] = useState<IndexState | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function readChain() {
      try {
        const block = await publicClient.getBlockNumber();
        // The contract reads are attempted only when an address is configured, and their failure is reported
        // separately from an RPC failure: "no contract here" and "no network" are different problems.
        let contract: Omit<ChainState, "block"> = { coverageToken: null, nextGuaranteeId: null, paused: null };
        if (hasDeployment()) {
          const [coverageToken, nextGuaranteeId, paused] = await Promise.all([
            publicClient.readContract({ address: CORE_ADDRESS, abi: coreAbi, functionName: "coverageToken" }),
            publicClient.readContract({ address: CORE_ADDRESS, abi: coreAbi, functionName: "nextGuaranteeId" }),
            publicClient.readContract({ address: CORE_ADDRESS, abi: coreAbi, functionName: "paused" }),
          ]);
          contract = { coverageToken, nextGuaranteeId, paused };
        }
        if (!cancelled) {
          setChain({ block, ...contract });
          setChainProbe("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setChainProbe("error");
          setChainError(e instanceof Error ? e.message : "Base Sepolia could not be reached.");
        }
      }
    }

    async function readIndex() {
      const supabase = getSupabase();
      if (!supabase) {
        if (!cancelled) setIndexProbe("unconfigured");
        return;
      }
      try {
        const [count, sync, observation] = await Promise.all([
          supabase.from("guarantees").select("id", { count: "exact", head: true }),
          supabase.from("chain_sync_public").select("*").maybeSingle(),
          supabase.from("observations").select("observed_at,healthy,tx_status")
            .order("observed_at", { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (count.error) throw count.error;
        if (sync.error) throw sync.error;
        if (observation.error) throw observation.error;
        if (!cancelled) {
          setIndex({
            guarantees: count.count ?? 0,
            sync: (sync.data as ChainSyncRow | null) ?? null,
            latestObservation: (observation.data as IndexState["latestObservation"]) ?? null,
          });
          setIndexProbe("ok");
        }
      } catch (e) {
        if (!cancelled) {
          setIndexProbe("error");
          setIndexError(e instanceof Error ? e.message : "The read model could not be queried.");
        }
      }
    }

    void Promise.all([readChain(), readIndex()]);
    return () => {
      cancelled = true;
    };
  }, []);

  const tokenMatches = chain?.coverageToken
    ? chain.coverageToken.toLowerCase() === USDC_ADDRESS.toLowerCase()
    : null;

  // Blocks behind the last block the indexer considered safe to read. Confirmation depth is deliberate, so a
  // small non-zero number here is correct behaviour rather than a fault.
  const lag = chain && index?.sync ? chain.block - BigInt(index.sync.safe_block) : null;
  const indexedBehindSafe = index?.sync
    ? BigInt(index.sync.safe_block) - BigInt(index.sync.last_synced_block)
    : null;

  const pill = (probe: Probe, ok = "Healthy") =>
    probe === "ok" ? ok : probe === "checking" ? "Checking" : probe === "unconfigured" ? "Pending" : "Failure";

  return (
    <section className="shell page-section">
      <div className="page-heading">
        <p className="eyebrow">Live infrastructure</p>
        <h1>System status</h1>
        <p>
          Every value on this page is read live from Base Sepolia or from the public read model when this page
          loads. Nothing is hard-coded green: a dependency that is missing or unreachable is shown as missing or
          unreachable.
        </p>
      </div>

      {!hasDeployment() ? (
        <div className="notice">
          <strong>No contract address is configured.</strong> This build has no{" "}
          <code>NEXT_PUBLIC_UPTIMESURE_CONTRACT</code>, so the settlement contract cannot be read and guarantees
          cannot be created. Contract-dependent rows below are reported as pending, not as healthy.
        </div>
      ) : null}
      {tokenMatches === false ? (
        <div className="notice notice-error">
          <strong>Token mismatch.</strong> The deployed contract settles in{" "}
          <code>{chain?.coverageToken}</code> but this build displays balances for <code>{USDC_ADDRESS}</code>.
          Do not fund a guarantee from this build until the addresses agree.
        </div>
      ) : null}
      {chain?.paused ? (
        <div className="notice notice-error">
          <strong>The settlement contract is paused.</strong> Its admin has halted observations and settlement.
          Existing coverage is untouched, but no new incident can be confirmed while it stays paused.
        </div>
      ) : null}
      {chainError ? <div className="notice notice-error">Base Sepolia: {chainError}</div> : null}
      {indexProbe === "unconfigured" ? (
        <div className="notice">
          <strong>The read model is not configured.</strong> Without{" "}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> the
          guarantee registry, observation history and indexer health cannot be shown. The contract remains
          readable and guarantees remain creatable — only the index is missing.
        </div>
      ) : null}
      {indexError ? <div className="notice notice-error">Read model: {indexError}</div> : null}

      <div className="metric-grid metric-grid-four">
        <div className="metric card">
          <span>Base Sepolia RPC</span>
          <strong>{chainProbe === "ok" ? "Online" : chainProbe === "checking" ? "Checking" : "Unavailable"}</strong>
          <small>{chain ? `Head block ${chain.block.toLocaleString()}` : `Chain ${BASE_SEPOLIA_CHAIN_ID}`}</small>
        </div>
        <div className="metric card">
          <span>Settlement contract</span>
          <strong>{hasDeployment() ? "Configured" : "Awaiting deployment"}</strong>
          <small>
            {hasDeployment() ? (
              <a href={`${BASE_SEPOLIA_EXPLORER}/address/${CORE_ADDRESS}`} target="_blank" rel="noreferrer">
                {short(CORE_ADDRESS)} on BaseScan
              </a>
            ) : (
              "No address injected into this build"
            )}
          </small>
        </div>
        <div className="metric card">
          <span>Read model</span>
          <strong>
            {indexProbe === "ok" ? "Online" : indexProbe === "checking" ? "Checking"
              : indexProbe === "unconfigured" ? "Not configured" : "Unavailable"}
          </strong>
          <small>{index ? `${index.guarantees} indexed guarantees` : "Public index"}</small>
        </div>
        <div className="metric card">
          <span>Latest monitor result</span>
          <strong>
            {index?.latestObservation
              ? index.latestObservation.tx_status === "unmonitorable"
                ? "Refused"
                : index.latestObservation.healthy ? "Healthy" : "Failure"
              : "None yet"}
          </strong>
          <small>
            {index?.latestObservation
              ? relativeDate(index.latestObservation.observed_at)
              : "Awaiting the first real probe"}
          </small>
        </div>
      </div>

      <div className="detail-grid">
        <article className="detail-card card">
          <p className="eyebrow">Live contract reads</p>
          <dl>
            <div><dt>Chain</dt><dd>Base Sepolia · {BASE_SEPOLIA_CHAIN_ID}</dd></div>
            <div>
              <dt>UptimeSureCore</dt>
              <dd>
                {hasDeployment() ? (
                  <a href={`${BASE_SEPOLIA_EXPLORER}/address/${CORE_ADDRESS}`} target="_blank" rel="noreferrer">
                    {short(CORE_ADDRESS, 10, 8)}
                  </a>
                ) : "Not deployed"}
              </dd>
            </div>
            <div>
              <dt>Settlement token (contract)</dt>
              <dd>
                {chain?.coverageToken ? (
                  <a
                    href={`${BASE_SEPOLIA_EXPLORER}/address/${chain.coverageToken}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(chain.coverageToken, 10, 8)}
                  </a>
                ) : "Unread"}
              </dd>
            </div>
            <div>
              <dt>Settlement token (this build)</dt>
              <dd>
                <a href={`${BASE_SEPOLIA_EXPLORER}/address/${USDC_ADDRESS}`} target="_blank" rel="noreferrer">
                  {short(USDC_ADDRESS, 10, 8)}
                </a>
              </dd>
            </div>
            <div>
              <dt>Guarantees issued</dt>
              <dd>{chain?.nextGuaranteeId == null ? "Unread" : (chain.nextGuaranteeId - 1n).toString()}</dd>
            </div>
            <div>
              <dt>Contract paused</dt>
              <dd>{chain?.paused == null ? "Unread" : chain.paused ? "Yes" : "No"}</dd>
            </div>
          </dl>
          <p className="card-note">
            Circle&apos;s Base Sepolia test USDC is <code>0x036CbD53842c5426634e7929541eC2318f3dCF7e</code>. Both
            token rows above should show it; a mismatch means this build is pointed at the wrong deployment.
          </p>
        </article>

        <article className="detail-card card">
          <p className="eyebrow">Component checks</p>
          <dl>
            <div><dt>Base Sepolia RPC</dt><dd><StatusPill status={pill(chainProbe)} /></dd></div>
            <div>
              <dt>Contract deployment</dt>
              <dd><StatusPill status={hasDeployment() ? "Healthy" : "Pending"} /></dd>
            </div>
            <div>
              <dt>Settlement token agrees</dt>
              <dd>
                <StatusPill status={tokenMatches == null ? "Pending" : tokenMatches ? "Healthy" : "Failure"} />
              </dd>
            </div>
            <div><dt>Read model</dt><dd><StatusPill status={pill(indexProbe)} /></dd></div>
            <div>
              <dt>Chain indexer</dt>
              <dd>
                <StatusPill
                  status={
                    indexProbe !== "ok" ? "Pending"
                      : index?.sync == null ? "Pending"
                      : index.sync.last_error ? "Failure"
                      : "Healthy"
                  }
                />
              </dd>
            </div>
            <div>
              <dt>Monitor</dt>
              <dd>
                <StatusPill status={index?.latestObservation ? "Healthy" : indexProbe === "ok" ? "Pending" : "Pending"} />
              </dd>
            </div>
          </dl>
          <p className="card-note">
            &ldquo;Pending&rdquo; means not yet configured or not yet exercised — it is not a claim that the
            component works.
          </p>
        </article>
      </div>

      <div className="section-subheading">
        <div>
          <p className="eyebrow">Indexer</p>
          <h2>Chain synchronisation</h2>
        </div>
        <span>{index?.sync ? `Chain ${index.sync.chain_id}` : "Not reporting"}</span>
      </div>
      <article className="detail-card card">
        {index?.sync ? (
          <>
            <dl>
              <div><dt>Deployment block</dt><dd>{BigInt(index.sync.deploy_block).toLocaleString()}</dd></div>
              <div>
                <dt>Indexed through</dt>
                <dd>{BigInt(index.sync.last_synced_block).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Safe block (confirmed)</dt>
                <dd>{BigInt(index.sync.safe_block).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Behind the safe block</dt>
                <dd>{indexedBehindSafe == null ? "Unknown" : `${indexedBehindSafe.toLocaleString()} blocks`}</dd>
              </div>
              <div>
                <dt>Confirmation depth</dt>
                <dd>{lag == null ? "Unknown" : `${lag.toLocaleString()} blocks behind head`}</dd>
              </div>
              <div><dt>Last run</dt><dd>{relativeDate(index.sync.last_run_at)}</dd></div>
              <div>
                <dt>Indexed contract</dt>
                <dd>
                  <a
                    href={`${BASE_SEPOLIA_EXPLORER}/address/${index.sync.contract_address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(index.sync.contract_address, 10, 8)}
                  </a>
                </dd>
              </div>
            </dl>
            {index.sync.last_error ? (
              <div className="notice notice-error">
                The last indexer run reported: {index.sync.last_error}
              </div>
            ) : null}
            <p className="card-note">
              The indexer deliberately stops short of the chain head so a reorganised block is never written into
              the read model. Being a few blocks behind is the design, not a fault. The contract, not this index,
              is the source of truth for coverage and payouts.
            </p>
          </>
        ) : (
          <p className="card-note" style={{ borderTop: 0, paddingTop: 0 }}>
            The indexer has not reported yet. Either the Supabase project is not deployed, or{" "}
            <code>sync-chain</code> has never run against this contract. No synthetic progress is shown in its
            place.
          </p>
        )}
      </article>

      <div className="section-subheading">
        <div>
          <p className="eyebrow">Trust boundary</p>
          <h2>Monitoring reports. It cannot move money.</h2>
        </div>
      </div>
      <article className="detail-card card">
        <dl>
          <div><dt>Who can record an observation</dt><dd>The monitor wallet, holding MONITOR_ROLE only</dd></div>
          <div><dt>Who receives compensation</dt><dd>The beneficiary fixed at creation, by the contract</dd></div>
          <div><dt>Who can change the payout size</dt><dd>Nobody, after creation</dd></div>
          <div><dt>Who can reclaim unused coverage</dt><dd>The provider, after expiry plus a settlement window</dd></div>
        </dl>
        <p className="card-note">
          A compromised monitor can record false failures or withhold true ones, which is the accepted trust
          assumption of this design. It cannot choose the beneficiary, alter the payout, pay an incident twice,
          replay an observation, or withdraw a provider&apos;s coverage — those are contract invariants with
          regression tests, not policy in the monitor.
        </p>
      </article>
    </section>
  );
}
