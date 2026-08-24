"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { connectWallet } from "@/lib/chain";
import { guaranteeStatus, relativeDate, short, usdc } from "@/lib/format";
import { normalizeAddress } from "@/lib/policy";
import { getSupabase } from "@/lib/supabase";
import { GuaranteeRow } from "@/lib/types";

type Role = "provider" | "beneficiary";

function sum(rows: GuaranteeRow[], pick: (row: GuaranteeRow) => string | number): bigint {
  return rows.reduce((total, row) => total + BigInt(pick(row) || 0), 0n);
}

/** Compensation already settled, derived from the indexed payout count rather than assumed. */
function settled(rows: GuaranteeRow[]): bigint {
  return rows.reduce(
    (total, row) => total + BigInt(row.payout_per_incident || 0) * BigInt(row.paid_payouts || 0),
    0n,
  );
}

function GuaranteeList({ rows, role }: { rows: GuaranteeRow[]; role: Role }) {
  return (
    <div className="cards-list">
      {rows.map((g) => {
        const status = guaranteeStatus(g.active, g.withdrawn, g.expires_at);
        return (
          <Link href={`/guarantees/${g.id}`} key={`${role}-${g.id}`} className="guarantee-card card">
            <div>
              <p className="eyebrow">Guarantee #{g.id}</p>
              <h3>{g.endpoint_url}</h3>
              <p>
                {g.paid_payouts}/{g.max_payouts} incidents paid · expires {relativeDate(g.expires_at)}
              </p>
            </div>
            <div className="guarantee-card-side">
              <StatusPill status={status} />
              <strong>{usdc(g.remaining_coverage)}</strong>
              <small>
                {g.consecutive_failures}/{g.failure_threshold} consecutive failures
              </small>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export default function DashboardPage() {
  const [wallet, setWallet] = useState<`0x${string}` | null>(null);
  const [rows, setRows] = useState<GuaranteeRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const connection = await connectWallet();
      // Validated to 42 hex characters before it reaches the filter string below. `.or()` is a small expression
      // language, so interpolating an unchecked value there would be an injection surface.
      const address = normalizeAddress(connection.address);
      if (!address) throw new Error("The wallet returned an address in an unexpected format.");
      setWallet(address);

      const supabase = getSupabase();
      if (!supabase) throw new Error("The read model is not configured, so guarantees cannot be listed.");
      const result = await supabase.from("guarantees").select("*")
        .or(`provider.eq.${address},beneficiary.eq.${address}`).order("id", { ascending: false });
      if (result.error) throw result.error;
      setRows((result.data || []) as GuaranteeRow[]);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load this wallet's guarantees.");
    } finally {
      setBusy(false);
    }
  }

  // A wallet can be both sides of different guarantees, and occasionally both sides of the same one, so the two
  // lists are filtered independently rather than partitioned. Sold and bought coverage are not netted together:
  // they are opposite exposures and adding them would produce a number that means nothing.
  const sold = wallet ? rows.filter((g) => g.provider.toLowerCase() === wallet) : [];
  const bought = wallet ? rows.filter((g) => g.beneficiary.toLowerCase() === wallet) : [];
  const byStatus = (list: GuaranteeRow[], status: string) =>
    list.filter((g) => guaranteeStatus(g.active, g.withdrawn, g.expires_at) === status);

  return (
    <section className="shell page-section">
      <div className="page-heading row-between">
        <div>
          <p className="eyebrow">Provider and beneficiary workspace</p>
          <h1>Dashboard</h1>
          <p>
            {wallet
              ? `Showing every indexed guarantee where ${short(wallet)} is the provider or the beneficiary.`
              : "Connect a wallet to see only the guarantees it is a party to. Nothing is shown for other wallets."}
          </p>
        </div>
        <button className="button button-primary" onClick={load} disabled={busy}>
          {busy ? "Loading…" : wallet ? "Refresh" : "Connect & load"}
        </button>
      </div>

      {error ? <div className="notice notice-error">{error}</div> : null}

      {wallet && loaded ? (
        <>
          <div className="metric-grid metric-grid-four">
            <div className="metric card">
              <span>Coverage you have sold</span>
              <strong>{usdc(sum(sold, (g) => g.remaining_coverage))}</strong>
              <small>{sold.length} guarantee{sold.length === 1 ? "" : "s"} as provider</small>
            </div>
            <div className="metric card">
              <span>Coverage protecting you</span>
              <strong>{usdc(sum(bought, (g) => g.remaining_coverage))}</strong>
              <small>{bought.length} guarantee{bought.length === 1 ? "" : "s"} as beneficiary</small>
            </div>
            <div className="metric card">
              <span>Compensation you have paid</span>
              <strong>{usdc(settled(sold))}</strong>
              <small>Across {sold.reduce((n, g) => n + g.paid_payouts, 0)} settled incidents</small>
            </div>
            <div className="metric card">
              <span>Compensation you received</span>
              <strong>{usdc(settled(bought))}</strong>
              <small>Across {bought.reduce((n, g) => n + g.paid_payouts, 0)} settled incidents</small>
            </div>
          </div>

          <div className="section-subheading">
            <div>
              <p className="eyebrow">As provider</p>
              <h2>Coverage you have sold</h2>
            </div>
            <span>
              {byStatus(sold, "Protected").length} protected · {byStatus(sold, "Exhausted").length} exhausted ·{" "}
              {byStatus(sold, "Expired").length} expired · {byStatus(sold, "Withdrawn").length} withdrawn
            </span>
          </div>
          {sold.length === 0 ? (
            <EmptyState
              title="This wallet has not sold coverage"
              body="Creating a guarantee funds it with test USDC and puts your service under continuous measurement."
              action={{ href: "/create", label: "Create a guarantee" }}
            />
          ) : (
            <GuaranteeList rows={sold} role="provider" />
          )}

          <div className="section-subheading">
            <div>
              <p className="eyebrow">As beneficiary</p>
              <h2>Coverage protecting you</h2>
            </div>
            <span>
              {byStatus(bought, "Protected").length} protected · {byStatus(bought, "Exhausted").length} exhausted
              · {byStatus(bought, "Expired").length} expired · {byStatus(bought, "Withdrawn").length} withdrawn
            </span>
          </div>
          {bought.length === 0 ? (
            <EmptyState
              title="No guarantee names this wallet as beneficiary"
              body="A provider sets the beneficiary when they create a guarantee, and it cannot be changed afterwards. Give them this address to be compensated for their outages."
            />
          ) : (
            <GuaranteeList rows={bought} role="beneficiary" />
          )}
        </>
      ) : null}

      {!wallet && !busy && !error ? (
        <EmptyState
          title="No wallet connected"
          body="This page reads guarantees filtered by your address. It shows nothing until you connect, and it never displays another wallet's position."
          action={{ href: "/guarantees", label: "Browse the public registry" }}
        />
      ) : null}
    </section>
  );
}
