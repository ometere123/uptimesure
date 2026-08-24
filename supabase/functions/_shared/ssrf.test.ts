import { assertEquals, assertRejects, assertThrows } from "std/assert";
import {
  assertSafeTarget,
  classifyAddress,
  isIpAddress,
  parseIpv4,
  parseIpv6,
  TargetRejected,
  validateUrlShape,
} from "./ssrf.ts";

/** Asserts that a URL is rejected, and with which code. A wrong-but-still-rejected code is still a bug. */
function assertRejected(raw: string, code: string) {
  const error = assertThrows(() => validateUrlShape(raw), TargetRejected);
  assertEquals((error as TargetRejected).code, code, `wrong rejection code for ${raw}: ${error.message}`);
}

Deno.test("parseIpv4 accepts dotted quads and rejects ambiguous encodings", () => {
  assertEquals(parseIpv4("192.168.0.1"), [192, 168, 0, 1]);
  assertEquals(parseIpv4("0.0.0.0"), [0, 0, 0, 0]);
  assertEquals(parseIpv4("255.255.255.255"), [255, 255, 255, 255]);
  // Leading zeros are octal to some resolvers: 0177.0.0.1 is 127.0.0.1. Refuse to guess.
  assertEquals(parseIpv4("010.0.0.1"), null);
  assertEquals(parseIpv4("0177.0.0.1"), null);
  assertEquals(parseIpv4("256.1.1.1"), null);
  assertEquals(parseIpv4("1.2.3"), null);
  assertEquals(parseIpv4("1.2.3.4.5"), null);
  assertEquals(parseIpv4("2130706433"), null);
  assertEquals(parseIpv4("1.2.3.-4"), null);
  assertEquals(parseIpv4(""), null);
});

Deno.test("parseIpv6 expands every text form", () => {
  assertEquals(parseIpv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assertEquals(parseIpv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assertEquals(parseIpv6("fe80::1"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assertEquals(parseIpv6("2001:db8::8a2e:370:7334"), [0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
  assertEquals(
    parseIpv6("2606:4700:4700:0000:0000:0000:0000:1111"),
    [0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111],
  );
  // IPv4-mapped forms embed 127.0.0.1 as the last two groups.
  assertEquals(parseIpv6("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  assertEquals(parseIpv6("::ffff:192.168.1.1"), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101]);
  assertEquals(parseIpv6("64:ff9b::169.254.169.254"), [0x64, 0xff9b, 0, 0, 0, 0, 0xa9fe, 0xa9fe]);
  // Zone identifiers are stripped, not treated as part of the address.
  assertEquals(parseIpv6("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  // Malformed.
  assertEquals(parseIpv6("1::2::3"), null);
  assertEquals(parseIpv6("12345::"), null);
  assertEquals(parseIpv6("1:2:3:4:5:6:7"), null);
  assertEquals(parseIpv6("1:2:3:4:5:6:7:8:9"), null);
  assertEquals(parseIpv6("gggg::1"), null);
  assertEquals(parseIpv6(""), null);
});

Deno.test("classifyAddress blocks every reserved IPv4 range", () => {
  const blocked: [string, string][] = [
    ["0.0.0.0", "this-network/8"],
    ["10.1.2.3", "private/8"],
    ["127.0.0.1", "loopback/8"],
    ["127.255.255.254", "loopback/8"],
    ["100.64.0.1", "cgnat/10"],
    ["100.127.255.255", "cgnat/10"],
    ["169.254.169.254", "link-local/16 (cloud metadata)"],
    ["172.16.0.1", "private/12"],
    ["172.31.255.255", "private/12"],
    ["192.0.0.1", "ietf-protocol/24"],
    ["192.0.2.1", "documentation/24"],
    ["192.88.99.1", "6to4-relay/24"],
    ["192.168.1.1", "private/16"],
    ["198.18.0.1", "benchmark/15"],
    ["198.51.100.1", "documentation/24"],
    ["203.0.113.1", "documentation/24"],
    ["224.0.0.1", "multicast/4"],
    ["239.255.255.255", "multicast/4"],
    ["240.0.0.1", "reserved/4"],
    ["255.255.255.255", "reserved/4"],
  ];
  for (const [address, label] of blocked) {
    assertEquals(classifyAddress(address), label, `${address} must be blocked`);
  }
});

Deno.test("classifyAddress allows genuinely public IPv4 addresses", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "104.16.132.229", "172.15.0.1", "172.32.0.1", "100.63.255.255"]) {
    assertEquals(classifyAddress(address), null, `${address} must be allowed`);
  }
});

Deno.test("classifyAddress blocks reserved IPv6 ranges including IPv4-in-IPv6 smuggling", () => {
  const blocked = [
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "100::1",
    "2001:db8::1",
    // The interesting cases: a public-looking IPv6 literal whose embedded IPv4 address is internal.
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.1.1",
    "::127.0.0.1",
    "64:ff9b::169.254.169.254",
    "2002:7f00:1::1",
    "2002:a00:1::1",
  ];
  for (const address of blocked) {
    const range = classifyAddress(address);
    assertEquals(typeof range, "string", `${address} must be blocked, got ${range}`);
  }
});

Deno.test("classifyAddress allows public IPv6 and rejects nonsense", () => {
  assertEquals(classifyAddress("2606:4700:4700::1111"), null);
  assertEquals(classifyAddress("2a00:1450:4001:81b::200e"), null);
  assertEquals(classifyAddress("::ffff:1.1.1.1"), null);
  assertEquals(classifyAddress("not-an-address"), "unparseable-address");
});

Deno.test("isIpAddress distinguishes literals from hostnames", () => {
  assertEquals(isIpAddress("1.1.1.1"), true);
  assertEquals(isIpAddress("::1"), true);
  assertEquals(isIpAddress("example.com"), false);
  assertEquals(isIpAddress("1.1.1.1.nip.io"), false);
});

Deno.test("validateUrlShape requires https", () => {
  assertRejected("http://example.com/health", "HTTPS_REQUIRED");
  assertRejected("file:///etc/passwd", "HTTPS_REQUIRED");
  assertRejected("gopher://example.com/", "HTTPS_REQUIRED");
  assertRejected("ftp://example.com/", "HTTPS_REQUIRED");
  assertRejected("ws://example.com/", "HTTPS_REQUIRED");
  assertRejected("data:text/plain,hi", "HTTPS_REQUIRED");
  assertRejected("not a url", "URL_UNPARSEABLE");
});

Deno.test("validateUrlShape strips no credentials — it refuses them", () => {
  assertRejected("https://user:pass@example.com/health", "URL_CREDENTIALS_FORBIDDEN");
  assertRejected("https://user@example.com/health", "URL_CREDENTIALS_FORBIDDEN");
  // The classic disguise: everything before '@' is userinfo, so this actually targets 169.254.169.254.
  assertRejected("https://example.com@169.254.169.254/latest/meta-data/", "URL_CREDENTIALS_FORBIDDEN");
});

Deno.test("validateUrlShape allows only 443 and 8443", () => {
  assertEquals(validateUrlShape("https://example.com/health").port, "");
  assertEquals(validateUrlShape("https://example.com:443/health").port, "");
  assertEquals(validateUrlShape("https://example.com:8443/health").port, "8443");
  for (const port of [22, 25, 3306, 5432, 6379, 8080, 9200, 11211, 2375]) {
    assertRejected(`https://example.com:${port}/health`, "PORT_FORBIDDEN");
  }
});

Deno.test("validateUrlShape blocks private IP literals in the host", () => {
  for (
    const host of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.9.9",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.100.100.200",
    ]
  ) {
    assertRejected(`https://${host}/health`, "PRIVATE_IP_FORBIDDEN");
  }
  for (const host of ["[::1]", "[fe80::1]", "[fc00::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[64:ff9b::169.254.169.254]"]) {
    assertRejected(`https://${host}/health`, "PRIVATE_IP_FORBIDDEN");
  }
});

Deno.test("validateUrlShape blocks obfuscated IP encodings", () => {
  // Every non-canonical numeric host is refused on the raw string, before WHATWG normalisation can rewrite it.
  // 010.010.010.010 is the reason this check exists: WHATWG reads the leading zeros as octal and produces
  // 8.8.8.8, while a decimal resolver produces 10.10.10.10. Refusing to pick a winner between two defensible
  // parses is the only safe answer, so an IP literal must be written as a canonical dotted quad.
  for (
    const host of ["2130706433", "0177.0.0.1", "127.1", "0x7f000001", "0", "010.010.010.010", "127.0.0.0x1"]
  ) {
    assertRejected(`https://${host}/health`, "IP_LITERAL_MALFORMED");
  }
  // Some forms are invalid enough that WHATWG refuses to parse them at all. Which layer catches them is an
  // implementation detail of the URL parser; that they are refused is the property under test.
  for (const host of ["999.1.1.1", "1.2.3.4.5", "1.1.1.1.1.1"]) {
    assertThrows(() => validateUrlShape(`https://${host}/health`), TargetRejected);
  }
  // A canonical quad still gets classified on its range rather than rejected as malformed.
  assertRejected("https://127.0.0.1/health", "PRIVATE_IP_FORBIDDEN");
  assertEquals(validateUrlShape("https://1.1.1.1/health").hostname, "1.1.1.1");
  // A real domain that begins with a digit must not be mistaken for an IP literal.
  assertEquals(validateUrlShape("https://1e100.net/health").hostname, "1e100.net");
  assertEquals(validateUrlShape("https://4chan.example.com/health").hostname, "4chan.example.com");
});

Deno.test("validateUrlShape is not bypassed by a trailing root dot", () => {
  // `new URL()` preserves a trailing dot, so a naive endsWith(".internal") check misses "db.internal.".
  for (const host of ["localhost.", "localhost..", "db.internal.", "metadata.google.internal.", "api.lan."]) {
    assertRejected(`https://${host}/health`, "PRIVATE_HOST_FORBIDDEN");
  }
  // A trailing dot on a public name is legal DNS and must still be accepted.
  assertEquals(validateUrlShape("https://example.com./health").protocol, "https:");
});

Deno.test("validateUrlShape is not bypassed by unicode or percent-encoded hostname tricks", () => {
  // IDNA maps the circled letter to a plain 'l', so this really is localhost.
  assertRejected("https://ⓛocalhost/health", "PRIVATE_HOST_FORBIDDEN");
  assertRejected("https://exam%70le.internal/health", "PRIVATE_HOST_FORBIDDEN");
  // Fullwidth digits normalise into an IPv4 literal in 0.0.0.0/8.
  assertRejected("https://１２３/health", "PRIVATE_IP_FORBIDDEN");
});

Deno.test("validateUrlShape blocks internal hostnames and single-label hosts", () => {
  for (
    const host of [
      "localhost",
      "LOCALHOST",
      "metadata.google.internal",
      "instance-data",
      "kubernetes.default.svc",
      "host.docker.internal",
      "db.internal",
      "printer.local",
      "wiki.corp",
      "api.lan",
      "something.test",
      "1.0.0.127.in-addr.arpa",
      "example.onion",
      "intranet",
    ]
  ) {
    assertRejected(`https://${host}/health`, "PRIVATE_HOST_FORBIDDEN");
  }
});

Deno.test("validateUrlShape accepts ordinary public endpoints", () => {
  for (
    const raw of [
      "https://example.com/health",
      "https://api.example.com/v1/status?deep=1",
      "https://example.co.uk:8443/healthz",
      "https://sub.domain.example.org/a/b/c#frag",
    ]
  ) {
    const url = validateUrlShape(raw);
    assertEquals(url.protocol, "https:");
  }
});

Deno.test("assertSafeTarget rejects a public name that resolves into private space", async () => {
  // The DNS-rebinding case: the hostname passes every syntactic check, and only resolution reveals the target.
  const resolver = (_host: string, type: "A" | "AAAA") =>
    type === "A" ? Promise.resolve(["169.254.169.254"]) : Promise.reject(new Error("NotFound"));
  const error = await assertRejects(
    () => assertSafeTarget("https://totally-legit.example.com/health", { resolver }),
    TargetRejected,
  );
  assertEquals((error as TargetRejected).code, "DNS_RESOLVES_TO_PRIVATE_IP");
});

Deno.test("assertSafeTarget rejects when any single answer is private", async () => {
  // A split answer must fail on the private record, not pass on the public one — fetch picks either.
  const resolver = (_host: string, type: "A" | "AAAA") =>
    type === "A" ? Promise.resolve(["93.184.216.34", "10.0.0.7"]) : Promise.resolve([]);
  const error = await assertRejects(
    () => assertSafeTarget("https://split.example.com/health", { resolver }),
    TargetRejected,
  );
  assertEquals((error as TargetRejected).code, "DNS_RESOLVES_TO_PRIVATE_IP");
});

Deno.test("assertSafeTarget rejects a private AAAA answer even when A is public", async () => {
  const resolver = (_host: string, type: "A" | "AAAA") =>
    type === "A" ? Promise.resolve(["93.184.216.34"]) : Promise.resolve(["fc00::1"]);
  const error = await assertRejects(
    () => assertSafeTarget("https://dual.example.com/health", { resolver }),
    TargetRejected,
  );
  assertEquals((error as TargetRejected).code, "DNS_RESOLVES_TO_PRIVATE_IP");
});

Deno.test("assertSafeTarget fails closed on an unresolvable host", async () => {
  const resolver = () => Promise.reject(new Error("NotFound"));
  const error = await assertRejects(
    () => assertSafeTarget("https://nxdomain.example.com/health", { resolver }),
    TargetRejected,
  );
  assertEquals((error as TargetRejected).code, "DNS_NO_RECORDS");
});

Deno.test("assertSafeTarget accepts a public host with public answers", async () => {
  const resolver = (_host: string, type: "A" | "AAAA") =>
    type === "A" ? Promise.resolve(["93.184.216.34"]) : Promise.resolve(["2606:2800:220:1:248:1893:25c8:1946"]);
  const { url, resolved } = await assertSafeTarget("https://example.com/health", { resolver });
  assertEquals(url.hostname, "example.com");
  assertEquals(resolved.length, 2);
});

Deno.test("assertSafeTarget does not resolve an IP literal that already passed classification", async () => {
  let called = false;
  const resolver = () => {
    called = true;
    return Promise.resolve([]);
  };
  const { resolved } = await assertSafeTarget("https://1.1.1.1/health", { resolver });
  assertEquals(called, false);
  assertEquals(resolved, ["1.1.1.1"]);
});
