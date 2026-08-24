"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { getSupabase } from "@/lib/supabase";
import { GuaranteeRow } from "@/lib/types";
import { guaranteeStatus, relativeDate, short, usdc } from "@/lib/format";

export default function GuaranteesPage() {
  const [rows, setRows] = useState<GuaranteeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setError("Supabase public configuration is not set yet.");
      setLoading(false);
      return;
    }
    supabase.from("guarantees").select("*").order("id", { ascending: false }).limit(100).then(({ data, error }) => {
      if (error) setError(error.message);
      else setRows((data || []) as GuaranteeRow[]);
      setLoading(false);
    });
  }, []);

  return (
    <section className="shell page-section">
      <div className="page-heading row-between">
        <div><p className="eyebrow">Public guarantee registry</p><h1>Guarantees</h1><p>Live read model indexed from the Base Sepolia contract. No sample guarantees are injected.</p></div>
        <Link href="/create" className="button button-primary">Create guarantee</Link>
      </div>
      {loading ? <div className="loading-card card">Loading indexed guarantees…</div> : null}
      {!loading && error ? <EmptyState title="Registry not connected" body={error} /> : null}
      {!loading && !error && rows.length === 0 ? <EmptyState title="No guarantees indexed yet" body="Deploy the contract, configure Supabase sync, then create the first funded guarantee." action={{ href: "/create", label: "Create first guarantee" }} /> : null}
      {rows.length > 0 ? (
        <div className="table-card card">
          <div className="table-row table-head"><span>Service</span><span>Status</span><span>Coverage left</span><span>Failures</span><span>Expires</span></div>
          {rows.map((g) => {
            const status = guaranteeStatus(g.active, g.withdrawn, g.expires_at);
            return <Link key={g.id} href={`/guarantees/${g.id}`} className="table-row table-link">
              <span><strong>Guarantee #{g.id}</strong><small>{short(g.endpoint_url, 34, 8)}</small></span>
              <span><StatusPill status={status} /></span>
              <span>{usdc(g.remaining_coverage)}</span>
              <span>{g.consecutive_failures}/{g.failure_threshold}</span>
              <span>{relativeDate(g.expires_at)}</span>
            </Link>;
          })}
        </div>
      ) : null}
    </section>
  );
}
