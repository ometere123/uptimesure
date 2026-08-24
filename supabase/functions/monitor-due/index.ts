import { createClient } from "npm:@supabase/supabase-js@2.56.1";
import { encodeAbiParameters, keccak256, stringToHex, toBytes } from "npm:viem@2.37.3";
import { authorizedCron, json } from "../_shared/auth.ts";
import { contractAddress, coreAbi, monitorWallet, publicClient } from "../_shared/chain.ts";

type GuaranteeRow = {
  id: number;
  endpoint_url: string;
  expected_status: number;
  expected_fragment: string;
  max_latency_ms: number;
  check_interval_seconds: number;
  expires_at: string;
};

type Probe = {
  healthy: boolean;
  status: number;
  latencyMs: number;
  bodySha256: `0x${string}`;
  errorCode: string;
};

const MAX_BODY = 65_536;
const TIMEOUT_MS = 8_000;
const MAX_DUE_PER_RUN = 10;
const PARALLELISM = 5;

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service credentials unavailable");
  return createClient(url, key, { auth: { persistSession: false } });
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function validateTarget(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
  if (url.username || url.password) throw new Error("URL_CREDENTIALS_FORBIDDEN");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new Error("PRIVATE_HOST_FORBIDDEN");
  }
  if (host.includes(":")) throw new Error("IP_LITERAL_FORBIDDEN");
  if (isPrivateIpv4(host)) throw new Error("PRIVATE_IP_FORBIDDEN");
  return url;
}

async function readLimitedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_BODY - total;
      const slice = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(slice);
      total += slice.length;
      if (value.length > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function hex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256(bytes: Uint8Array): Promise<`0x${string}`> {
  const copy = Uint8Array.from(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)));
}

async function probe(row: GuaranteeRow): Promise<Probe> {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = validateTarget(row.endpoint_url);
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: { "accept": "*/*", "user-agent": "UptimeSure-Monitor/1.0" },
    });
    const body = await readLimitedBody(response);
    const latencyMs = Math.round(performance.now() - started);
    const text = new TextDecoder().decode(body);
    const fragmentOk = !row.expected_fragment || text.includes(row.expected_fragment);
    const healthy = response.status === row.expected_status && latencyMs <= row.max_latency_ms && fragmentOk;
    return {
      healthy,
      status: response.status,
      latencyMs,
      bodySha256: await sha256(body),
      errorCode: healthy ? "OK" : response.status !== row.expected_status ? "STATUS_MISMATCH" : !fragmentOk ? "BODY_MISMATCH" : "LATENCY_BREACH",
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const code = error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : error instanceof Error ? error.message.slice(0, 64) : "FETCH_ERROR";
    return { healthy: false, status: 0, latencyMs, bodySha256: await sha256(new Uint8Array()), errorCode: code };
  } finally {
    clearTimeout(timeout);
  }
}

async function processGuarantee(row: GuaranteeRow) {
  const supabase = adminClient();
  const observedAt = Math.floor(Date.now() / 1000);
  const observationId = keccak256(stringToHex(`${row.id}:${observedAt}:${crypto.randomUUID()}`));
  const result = await probe(row);
  const errorHash = keccak256(toBytes(result.errorCode));
  const evidenceHash = keccak256(encodeAbiParameters(
    [
      { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }, { type: "bool" },
      { type: "uint16" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }
    ],
    [BigInt(row.id), observationId, BigInt(observedAt), result.healthy, result.status, result.latencyMs, result.bodySha256, errorHash]
  ));

  const inserted = await supabase.from("observations").insert({
    observation_id: observationId,
    guarantee_id: row.id,
    observed_at: new Date(observedAt * 1000).toISOString(),
    healthy: result.healthy,
    http_status: result.status,
    latency_ms: result.latencyMs,
    body_sha256: result.bodySha256,
    evidence_hash: evidenceHash,
    error_code: result.errorCode,
    tx_status: "pending",
  });
  if (inserted.error) throw new Error(`OBSERVATION_STORE_FAILED:${inserted.error.message}`);

  let txHash: `0x${string}` | null = null;
  let chainRequired = true;
  try {
    const client = publicClient();
    const chainGuarantee = await client.readContract({
      address: contractAddress(),
      abi: coreAbi,
      functionName: "getGuarantee",
      args: [BigInt(row.id)],
    });

    if (!chainGuarantee.active || chainGuarantee.withdrawn) {
      chainRequired = false;
      await supabase.from("observations").update({ tx_status: "not_required", chain_error: "GUARANTEE_INACTIVE_ONCHAIN" }).eq("observation_id", observationId);
      await supabase.from("guarantees").update({ active: chainGuarantee.active, withdrawn: chainGuarantee.withdrawn }).eq("id", row.id);
      return { id: row.id, healthy: result.healthy, status: result.status, latencyMs: result.latencyMs, txHash, chainRequired };
    }

    // Healthy steady-state probes remain in the evidence store and do not burn
    // testnet gas. A healthy result is submitted onchain only when it must reset
    // an existing failure streak/recover an incident. Every failure is onchain.
    if (result.healthy && Number(chainGuarantee.consecutiveFailures) === 0) {
      chainRequired = false;
      await supabase.from("observations").update({ tx_status: "not_required" }).eq("observation_id", observationId);
      return { id: row.id, healthy: true, status: result.status, latencyMs: result.latencyMs, txHash, chainRequired };
    }

    const { wallet, account } = monitorWallet();
    const { request } = await client.simulateContract({
      address: contractAddress(),
      abi: coreAbi,
      functionName: "submitObservation",
      args: [BigInt(row.id), observationId, result.healthy, evidenceHash, BigInt(observedAt)],
      account,
    });
    txHash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 60_000 });
    await supabase.from("observations").update({
      tx_hash: txHash,
      tx_status: receipt.status === "success" ? "confirmed" : "failed",
      chain_error: receipt.status === "success" ? null : "TRANSACTION_REVERTED",
    }).eq("observation_id", observationId);
  } catch (error) {
    await supabase.from("observations").update({
      tx_hash: txHash,
      tx_status: "failed",
      chain_error: error instanceof Error ? error.message.slice(0, 240) : "CHAIN_ERROR",
    }).eq("observation_id", observationId);
  } finally {
    const next = new Date(Date.now() + row.check_interval_seconds * 1000).toISOString();
    await supabase.from("guarantees").update({ next_check_at: next }).eq("id", row.id);
  }

  return { id: row.id, healthy: result.healthy, status: result.status, latencyMs: result.latencyMs, txHash, chainRequired };
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!authorizedCron(req)) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({})) as { limit?: number };
    const limit = Math.max(1, Math.min(Number(body.limit || MAX_DUE_PER_RUN), MAX_DUE_PER_RUN));
    const supabase = adminClient();
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("guarantees")
      .select("id,endpoint_url,expected_status,expected_fragment,max_latency_ms,check_interval_seconds,expires_at")
      .eq("active", true)
      .eq("withdrawn", false)
      .lte("next_check_at", nowIso)
      .gt("expires_at", nowIso)
      .order("next_check_at", { ascending: true })
      .limit(limit);

    if (error) return json({ error: error.message }, 500);
    const rows = (data || []) as GuaranteeRow[];
    const results = [];
    for (let i = 0; i < rows.length; i += PARALLELISM) {
      results.push(...await Promise.all(rows.slice(i, i + PARALLELISM).map(processGuarantee)));
    }
    return json({ checked: results.length, results });
  },
};
