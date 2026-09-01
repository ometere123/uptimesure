import { resolve4, resolve6 } from "node:dns/promises";
import { classifyAddress, isIpAddress, validateUrlShape } from "../../../supabase/functions/_shared/ssrf";

export async function evaluatePreflight(raw: string, resolver = async (host: string, type: "A" | "AAAA") =>
  type === "A" ? resolve4(host) : resolve6(host)) {
  const url = validateUrlShape(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const addresses = isIpAddress(host) ? [host] : (await Promise.allSettled([resolver(host, "A"), resolver(host, "AAAA")])).flatMap((r) => r.status === "fulfilled" ? r.value : []);
  if (!addresses.length) throw new Error("DNS_NO_RECORDS");
  for (const address of addresses) if (classifyAddress(address)) throw new Error("DNS_RESOLVES_TO_PRIVATE_IP");
  return { ok: true, addresses, redirects: "manual" as const };
}

export async function POST(request: Request) {
  const { url: raw } = await request.json().catch(() => ({ url: "" }));
  try {
    return Response.json(await evaluatePreflight(String(raw)));
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "PREFLIGHT_FAILED" }, { status: 400 });
  }
}
