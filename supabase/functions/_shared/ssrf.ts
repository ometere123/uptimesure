/**
 * SSRF defence for the monitoring probe.
 *
 * The monitor fetches URLs chosen by an untrusted third party (whoever created the guarantee) from inside
 * Supabase's Edge runtime, which sits on a network with reachable internal services and a cloud metadata
 * endpoint. Anything less than an explicit allowlist posture here is a server-side request forgery primitive.
 *
 * Layered defence:
 *   1. Scheme, credential, port and hostname-shape checks on the URL string.
 *   2. Classification of any IP literal in the host.
 *   3. DNS pre-resolution: every A and AAAA answer for the hostname is classified, so a name that looks
 *      public but resolves into private space is rejected (the "DNS rebinding" case).
 *   4. The caller must use `redirect: "manual"`, so a 30x cannot walk the request to an unvalidated host.
 *
 * Residual risk, stated honestly: `fetch` resolves the hostname again itself, so a DNS answer that changes
 * between step 3 and the request could still be pointed elsewhere (a classic TOCTOU). Deno's `fetch` gives
 * no hook to pin a connection to a pre-validated address, so this cannot be closed at this layer. It is
 * bounded by the low TTL window, by refusing redirects, and by the fact that a successful rebind yields no
 * response content to the attacker: the monitor stores only a status code, a latency and a body digest.
 * See docs/SECURITY.md.
 */

export type RejectionCode =
  | "URL_UNPARSEABLE"
  | "HTTPS_REQUIRED"
  | "URL_CREDENTIALS_FORBIDDEN"
  | "HOST_MISSING"
  | "PORT_FORBIDDEN"
  | "PRIVATE_HOST_FORBIDDEN"
  | "PRIVATE_IP_FORBIDDEN"
  | "IP_LITERAL_MALFORMED"
  | "DNS_NO_RECORDS"
  | "DNS_RESOLUTION_FAILED"
  | "DNS_RESOLVES_TO_PRIVATE_IP";

export class TargetRejected extends Error {
  readonly code: RejectionCode;
  constructor(code: RejectionCode, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "TargetRejected";
    this.code = code;
  }
}

/** Ports the monitor is willing to talk to. Narrowing this shrinks the internal port-scan surface. */
const ALLOWED_PORTS = new Set(["", "443", "8443"]);

/**
 * Hostname suffixes that are never public. `.arpa` covers reverse-DNS tricks, and a single-label hostname
 * (no dot at all) can only be an internal search-domain lookup.
 */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".corp",
  ".home",
  ".home.arpa",
  ".lan",
  ".private",
  ".arpa",
  ".onion",
  ".test",
  ".example",
  ".invalid",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
  "host.docker.internal",
  "gateway.docker.internal",
]);

/** IPv4 ranges that must never be reached. Each entry is [firstOctetPredicate, label]. */
function classifyIpv4(octets: number[]): string | null {
  const [a, b, c, d] = octets;
  if (a === 0) return "this-network/8";
  if (a === 10) return "private/8";
  if (a === 127) return "loopback/8";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat/10";
  if (a === 169 && b === 254) return "link-local/16 (cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "private/12";
  if (a === 192 && b === 0 && c === 0) return "ietf-protocol/24";
  if (a === 192 && b === 0 && c === 2) return "documentation/24";
  if (a === 192 && b === 88 && c === 99) return "6to4-relay/24";
  if (a === 192 && b === 168) return "private/16";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark/15";
  if (a === 198 && b === 51 && c === 100) return "documentation/24";
  if (a === 203 && b === 0 && c === 113) return "documentation/24";
  if (a >= 224 && a <= 239) return "multicast/4";
  if (a >= 240) return "reserved/4";
  if (a === 255 && b === 255 && c === 255 && d === 255) return "broadcast";
  return null;
}

export function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject leading zeros: "010.0.0.1" is octal to some resolvers and decimal to others.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Expands an IPv6 text form into its 8 groups, or null if malformed. Handles `::` and IPv4-in-IPv6 tails. */
export function parseIpv6(host: string): number[] | null {
  let text = host;
  // Strip a zone identifier: fe80::1%eth0
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length === 0 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  if ((text.match(/::/g) || []).length > 1) return null;

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const trailer = lastColon === -1 ? "" : text.slice(lastColon + 1);
  if (trailer.includes(".")) {
    const v4 = parseIpv4(trailer);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1) + "0";
  }

  const [head, rest] = text.includes("::") ? text.split("::") : [text, null];
  const headGroups = head === "" ? [] : head.split(":");
  const restGroups = rest == null || rest === "" ? [] : rest.split(":");
  const literal = [...headGroups, ...restGroups];
  if (literal.some((g) => g === "" || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g))) return null;

  const explicit = literal.map((g) => parseInt(g, 16));
  // The synthetic "0" group added for an IPv4 tail is replaced by the two real groups.
  const withTail = trailer.includes(".") ? [...explicit.slice(0, -1), ...tail] : explicit;

  if (rest == null) return withTail.length === 8 ? withTail : null;
  const fill = 8 - withTail.length;
  if (fill < 0) return null;
  const headCount = trailer.includes(".")
    ? headGroups.filter((g) => g !== "").length
    : headGroups.filter((g) => g !== "").length;
  const front = withTail.slice(0, headCount);
  const back = withTail.slice(headCount);
  return [...front, ...new Array(fill).fill(0), ...back];
}

function classifyIpv6(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5] = groups;
  const allZeroExceptLast = groups.slice(0, 7).every((g) => g === 0);
  if (allZeroExceptLast && groups[7] === 0) return "unspecified ::";
  if (allZeroExceptLast && groups[7] === 1) return "loopback ::1";

  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d — classify the embedded address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    const embedded = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    const v4 = classifyIpv4(embedded);
    return v4 ? `ipv4-mapped ${v4}` : null;
  }
  // NAT64 well-known prefix 64:ff9b::/96 also embeds an IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const embedded = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
    return `nat64 ${classifyIpv4(embedded) ?? "translated"}`;
  }
  // 6to4 2002::/16 embeds an IPv4 address in the next 32 bits.
  if (g0 === 0x2002) {
    const embedded = [g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff];
    return `6to4 ${classifyIpv4(embedded) ?? "tunnel"}`;
  }
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard-only/64";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation/32";
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local fc00::/7";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local fe80::/10";
  if ((g0 & 0xff00) === 0xff00) return "multicast ff00::/8";
  return null;
}

/** Classifies a bare IP address string. Returns a human-readable range label when it must be blocked. */
export function classifyAddress(address: string): string | null {
  const v4 = parseIpv4(address);
  if (v4) return classifyIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6) return classifyIpv6(v6);
  return "unparseable-address";
}

/** True when the string is a syntactically valid IP address of either family. */
export function isIpAddress(value: string): boolean {
  return parseIpv4(value) !== null || parseIpv6(value) !== null;
}

export type DnsResolver = (hostname: string, recordType: "A" | "AAAA") => Promise<string[]>;

const denoResolver: DnsResolver = async (hostname, recordType) => {
  // deno-lint-ignore no-explicit-any
  const resolve = (globalThis as { Deno?: { resolveDns?: unknown } }).Deno?.resolveDns;
  if (typeof resolve !== "function") throw new TargetRejected("DNS_RESOLUTION_FAILED", "resolveDns unavailable");
  return await resolve(hostname, recordType) as string[];
};

/**
 * Extracts the host substring exactly as the guarantee author wrote it, before any WHATWG normalisation.
 *
 * This matters because `new URL()` silently rewrites numeric hosts using the WHATWG rules: `2130706433`,
 * `0x7f000001`, `0177.0.0.1` and `127.1` all become `127.0.0.1`, and — the dangerous direction —
 * `010.010.010.010` becomes `8.8.8.8` because leading zeros are read as octal. A resolver that reads those
 * same digits as decimal would go to `10.10.10.10` instead. Rather than pick a winner between two defensible
 * parses, the raw form is required to be unambiguous.
 */
function rawHostOf(raw: string): string {
  const afterScheme = raw.slice(raw.indexOf("://") + 3);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  const afterUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
  if (afterUserinfo.startsWith("[")) return afterUserinfo.slice(0, afterUserinfo.indexOf("]") + 1);
  const colon = afterUserinfo.indexOf(":");
  return (colon === -1 ? afterUserinfo : afterUserinfo.slice(0, colon)).toLowerCase();
}

/**
 * True when every dot-separated label of the raw host is numeric or hex-prefixed, i.e. the author was writing
 * an IP address rather than a hostname. Judged per label so that real domains starting with a digit — such as
 * `1e100.net` — are still treated as hostnames, because their trailing labels are not numeric.
 */
function looksLikeIpLiteral(host: string): boolean {
  if (host === "" || !/^[0-9]/.test(host)) return false;
  return host.split(".").every((label) => /^(0x[0-9a-f]*|[0-9]+)$/.test(label));
}

/**
 * Validates the URL string only. Split out from {@link assertSafeTarget} so the syntactic rules can be
 * unit-tested without a network or DNS.
 */
export function validateUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetRejected("URL_UNPARSEABLE");
  }
  if (url.protocol !== "https:") throw new TargetRejected("HTTPS_REQUIRED", url.protocol);
  if (url.username !== "" || url.password !== "") throw new TargetRejected("URL_CREDENTIALS_FORBIDDEN");
  if (!ALLOWED_PORTS.has(url.port)) throw new TargetRejected("PORT_FORBIDDEN", url.port);

  // A host the author wrote as an IP address must be written canonically, so no two parsers can disagree
  // about the target. Checked on the raw string because WHATWG normalisation happens before we see the host.
  const written = rawHostOf(raw);
  if (looksLikeIpLiteral(written) && parseIpv4(written) === null) {
    throw new TargetRejected("IP_LITERAL_MALFORMED", written);
  }

  // WHATWG URL lowercases and punycodes the host, and keeps the brackets on an IPv6 literal. A trailing root
  // dot survives normalisation, so `localhost..` would otherwise slip past the hostname blocklist below.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") throw new TargetRejected("HOST_MISSING");

  const bracketed = host.startsWith("[") && host.endsWith("]");
  const bare = bracketed ? host.slice(1, -1) : host;

  if (bracketed || bare.includes(":")) {
    const groups = parseIpv6(bare);
    if (!groups) throw new TargetRejected("IP_LITERAL_MALFORMED", bare);
    const range = classifyIpv6(groups);
    if (range) throw new TargetRejected("PRIVATE_IP_FORBIDDEN", range);
    return url;
  }

  const v4 = parseIpv4(bare);
  if (v4) {
    const range = classifyIpv4(v4);
    if (range) throw new TargetRejected("PRIVATE_IP_FORBIDDEN", range);
    return url;
  }

  // Digits-and-dots that did not parse as a dotted quad is a malformed literal, not a hostname.
  if (/^[0-9.]+$/.test(bare) || /^0x[0-9a-f]+$/.test(bare)) {
    throw new TargetRejected("IP_LITERAL_MALFORMED", bare);
  }

  if (BLOCKED_HOSTS.has(bare)) throw new TargetRejected("PRIVATE_HOST_FORBIDDEN", bare);
  if (!bare.includes(".")) throw new TargetRejected("PRIVATE_HOST_FORBIDDEN", "single-label host");
  for (const suffix of BLOCKED_SUFFIXES) {
    if (bare.endsWith(suffix)) throw new TargetRejected("PRIVATE_HOST_FORBIDDEN", suffix);
  }
  return url;
}

/**
 * Full validation: URL shape, then DNS. Throws {@link TargetRejected} with a stable code on any failure.
 * A rejection is a policy decision about the target, not evidence that the endpoint is down — callers must
 * keep the two apart so a malformed guarantee can never manufacture an outage.
 */
export async function assertSafeTarget(
  raw: string,
  options: { resolver?: DnsResolver } = {},
): Promise<{ url: URL; resolved: string[] }> {
  const url = validateUrlShape(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

  // An IP literal was already classified; there is nothing to resolve.
  if (isIpAddress(host)) return { url, resolved: [host] };

  const resolver = options.resolver ?? denoResolver;
  const answers: string[] = [];
  const failures: string[] = [];
  for (const recordType of ["A", "AAAA"] as const) {
    try {
      answers.push(...await resolver(host, recordType));
    } catch (error) {
      if (error instanceof TargetRejected) throw error;
      // NotFound for one family is normal (an IPv4-only host has no AAAA). Record it and judge on the union.
      failures.push(error instanceof Error ? error.name : String(error));
    }
  }

  if (answers.length === 0) {
    // Fail closed: an unresolvable host is not monitorable, and treating it as an outage would let a bad
    // guarantee mint incidents out of a typo.
    throw new TargetRejected("DNS_NO_RECORDS", failures.join(",").slice(0, 64) || "no A/AAAA answers");
  }

  for (const address of answers) {
    const range = classifyAddress(address);
    if (range) throw new TargetRejected("DNS_RESOLVES_TO_PRIVATE_IP", `${address} ${range}`);
  }
  return { url, resolved: answers };
}
