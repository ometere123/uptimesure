import { assertEquals, assertNotEquals, assertThrows } from "std/assert";
import { encodeAbiParameters, keccak256, stringToBytes } from "npm:viem@2.55.19";
import {
  encodeEvidence,
  EVIDENCE_DOMAIN,
  evidenceHash,
  type EvidencePayload,
  hashText,
  OBSERVATION_DOMAIN,
  observationId,
} from "./evidence.ts";
import { checkCronAuth, MIN_CRON_SECRET_LENGTH, timingSafeEqual } from "./auth.ts";

const SAMPLE: EvidencePayload = {
  guaranteeId: 1n,
  observationId: `0x${"11".repeat(32)}`,
  url: "https://example.com/health",
  observedAt: 1_750_000_000,
  status: 200,
  latencyMs: 143,
  healthy: true,
  reason: "OK",
  bodyDigest: `0x${"22".repeat(32)}`,
};

Deno.test("domain separators are the documented keccak256 values", () => {
  assertEquals(OBSERVATION_DOMAIN, keccak256(stringToBytes("uptimesure.observation.v1")));
  assertEquals(EVIDENCE_DOMAIN, keccak256(stringToBytes("uptimesure.evidence.v1")));
  assertNotEquals(OBSERVATION_DOMAIN, EVIDENCE_DOMAIN, "an id must never be confusable with an evidence hash");
});

Deno.test("evidenceHash equals keccak256 of a hand-built abi.encode preimage", () => {
  // Reproduces the digest the way an auditor would: independently, from the documented field list.
  const expected = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bool" },
      { type: "uint16" },
      { type: "uint32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      keccak256(stringToBytes("uptimesure.evidence.v1")),
      1n,
      SAMPLE.observationId,
      keccak256(stringToBytes("https://example.com/health")),
      1_750_000_000n,
      true,
      200,
      143,
      SAMPLE.bodyDigest,
      keccak256(stringToBytes("OK")),
    ],
  ));
  assertEquals(evidenceHash(SAMPLE), expected);
});

Deno.test("evidenceHash is deterministic and 32 bytes", () => {
  assertEquals(evidenceHash(SAMPLE), evidenceHash({ ...SAMPLE }));
  assertEquals(/^0x[0-9a-f]{64}$/.test(evidenceHash(SAMPLE)), true);
});

Deno.test("evidenceHash changes when any field changes", () => {
  const base = evidenceHash(SAMPLE);
  const mutations: Partial<EvidencePayload>[] = [
    { guaranteeId: 2n },
    { observationId: `0x${"33".repeat(32)}` },
    { url: "https://example.com/health2" },
    { observedAt: 1_750_000_001 },
    { status: 201 },
    { latencyMs: 144 },
    { healthy: false },
    { reason: "STATUS_MISMATCH" },
    { bodyDigest: `0x${"44".repeat(32)}` },
  ];
  for (const mutation of mutations) {
    assertNotEquals(
      evidenceHash({ ...SAMPLE, ...mutation }),
      base,
      `digest unchanged for ${JSON.stringify(mutation, (_k, v) => typeof v === "bigint" ? String(v) : v)}`,
    );
  }
});

Deno.test("variable-length fields cannot be shifted between each other", () => {
  // If url and reason were concatenated rather than each hashed to a fixed slot, moving a character from one
  // to the other would leave the digest unchanged. That would let a monitor rewrite the probed endpoint.
  const a = evidenceHash({ ...SAMPLE, url: "https://example.com/heal", reason: "thOK" });
  const b = evidenceHash({ ...SAMPLE, url: "https://example.com/health", reason: "OK" });
  assertNotEquals(a, b);
});

Deno.test("encodeEvidence exposes a fixed-width preimage", () => {
  const preimage = encodeEvidence(SAMPLE);
  // 10 static fields, 32 bytes each, no dynamic tail: 320 bytes -> 640 hex chars.
  assertEquals(preimage.length, 2 + 640);
  assertEquals(keccak256(preimage), evidenceHash(SAMPLE));
});

Deno.test("observationId is stable per guarantee and slot, and distinct across both", () => {
  const a = observationId(1n, "2026-08-24T12:00:00.000Z");
  const b = observationId(1n, "2026-08-24T12:00:00.000Z");
  assertEquals(a, b, "a retried slot must reuse its id so the contract's replay guard absorbs the duplicate");
  assertNotEquals(a, observationId(1n, "2026-08-24T12:01:00.000Z"));
  assertNotEquals(a, observationId(2n, "2026-08-24T12:00:00.000Z"));
});

Deno.test("observationId ignores how the slot instant is spelled", () => {
  // PostgREST may render the same timestamptz as `+00:00`, and a Date object may arrive instead of a string.
  const canonical = observationId(1n, "2026-08-24T12:00:00.000Z");
  assertEquals(observationId(1n, "2026-08-24T12:00:00+00:00"), canonical);
  assertEquals(observationId(1n, "2026-08-24T13:00:00+01:00"), canonical);
  assertEquals(observationId(1n, new Date("2026-08-24T12:00:00.000Z")), canonical);
});

Deno.test("observationId refuses an unusable slot instead of hashing NaN", () => {
  assertThrows(() => observationId(1n, "not-a-timestamp"), Error, "INVALID_SLOT");
  assertThrows(() => observationId(1n, "1969-01-01T00:00:00Z"), Error, "SLOT_BEFORE_EPOCH");
});

Deno.test("hashText folds a string into a bytes32 slot", () => {
  assertEquals(hashText("OK"), keccak256(stringToBytes("OK")));
  assertNotEquals(hashText(""), hashText("OK"));
});

Deno.test("timingSafeEqual compares correctly", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "abcd"), false);
  assertEquals(timingSafeEqual("", ""), true);
  assertEquals(timingSafeEqual("é", "é"), true);
});

function requestWith(secret?: string): Request {
  const headers = new Headers();
  if (secret !== undefined) headers.set("x-uptimesure-cron-secret", secret);
  return new Request("https://functions.local/monitor-due", { method: "POST", headers });
}

Deno.test("checkCronAuth accepts a matching long secret", () => {
  const secret = "s".repeat(MIN_CRON_SECRET_LENGTH);
  assertEquals(checkCronAuth(requestWith(secret), secret), { ok: true });
});

Deno.test("checkCronAuth rejects a wrong secret as unauthorized", () => {
  const secret = "s".repeat(MIN_CRON_SECRET_LENGTH);
  assertEquals(checkCronAuth(requestWith("x".repeat(MIN_CRON_SECRET_LENGTH)), secret), {
    ok: false,
    reason: "UNAUTHORIZED",
  });
  assertEquals(checkCronAuth(requestWith(undefined), secret), { ok: false, reason: "UNAUTHORIZED" });
});

Deno.test("checkCronAuth fails closed when the server secret is absent or too short", () => {
  // A missing secret must never mean "allow everyone".
  assertEquals(checkCronAuth(requestWith("anything"), undefined), { ok: false, reason: "MISCONFIGURED" });
  assertEquals(checkCronAuth(requestWith(""), ""), { ok: false, reason: "MISCONFIGURED" });
  assertEquals(checkCronAuth(requestWith("short"), "short"), { ok: false, reason: "MISCONFIGURED" });
});
