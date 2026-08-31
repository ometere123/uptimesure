import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

const PORTS = new Set(["", "443", "8443"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".corp", ".home", ".home.arpa", ".lan", ".private", ".arpa", ".onion", ".test", ".example", ".invalid"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal", "kubernetes", "kubernetes.default", "kubernetes.default.svc", "host.docker.internal", "gateway.docker.internal"]);

function privateV4(value: string): boolean {
  const p = value.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function privateAddress(value: string): boolean {
  if (isIP(value) === 4) return privateV4(value);
  if (isIP(value) !== 6) return true;
  const hex = value.toLowerCase().split("::");
  const groups = (hex[0] ? hex[0].split(":") : []).concat(hex[1] ? hex[1].split(":") : []);
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return true;
  const first = parseInt(groups[0] ?? "0", 16);
  return value === "::" || value === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || value.toLowerCase().startsWith("::ffff:") || value.toLowerCase().startsWith("64:ff9b:");
}

export async function POST(request: Request) {
  const { url: raw } = await request.json().catch(() => ({ url: "" }));
  try {
    const url = new URL(String(raw));
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
    if (url.username || url.password) throw new Error("URL_CREDENTIALS_FORBIDDEN");
    if (!PORTS.has(url.port)) throw new Error("PORT_FORBIDDEN");
    if (!host || BLOCKED_HOSTS.has(host) || !host.includes(".") || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new Error("PRIVATE_HOST_FORBIDDEN");
    const addresses = isIP(host) ? [host] : (await Promise.allSettled([resolve4(host), resolve6(host)])).flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!addresses.length || addresses.some(privateAddress)) throw new Error("DNS_RESOLVES_TO_PRIVATE_IP");
    return Response.json({ ok: true, addresses, redirects: "manual" });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "PREFLIGHT_FAILED" }, { status: 400 });
  }
}
