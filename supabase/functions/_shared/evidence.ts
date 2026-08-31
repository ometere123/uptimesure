/**
 * Deterministic evidence hashing and observation identity.
 *
 * The onchain record stores only a 32-byte digest of what the monitor saw. For that digest to be worth
 * anything, three independent parties - the monitor, the frontend, and a third-party auditor holding only the
 * database row - must compute the same value from the same facts. So the canonical form is fixed here, in one
 * place, and unit-tested.
 *
 * The encoding is `keccak256(abi.encode(...))` rather than a JSON or line-oriented digest. This is an EVM
 * product: an auditor can reproduce any hash below with viem in the browser, with `abi.encode` inside a
 * Solidity verifier, or with `cast abi-encode` from a shell, and the encoding has no ambiguity to argue about
 * (no key ordering, no whitespace, no number formatting, no unicode normalisation).
 *
 * Two rules make the scheme replay-resistant:
 *   * Every digest is domain-separated, so an observation hash can never be mistaken for an id or vice versa.
 *   * Variable-length inputs (url, reason) are hashed to bytes32 before encoding, so no two distinct field
 *     pairs can produce the same encoded byte string.
 */

import { encodeAbiParameters, keccak256, stringToBytes } from "npm:viem@2.55.19";

/** Namespace for observation ids. keccak256("uptimesure.observation.v1"). */
export const OBSERVATION_DOMAIN = keccak256(stringToBytes("uptimesure.observation.v1"));

/** Namespace for evidence digests. keccak256("uptimesure.evidence.v1"). */
export const EVIDENCE_DOMAIN = keccak256(stringToBytes("uptimesure.evidence.v1"));

export interface EvidencePayload {
  /** Onchain guarantee id. */
  guaranteeId: bigint;
  /** The observation id this evidence belongs to. Binds evidence to a single slot. */
  observationId: `0x${string}`;
  /** The exact URL probed, after target-policy normalisation. */
  url: string;
  /** Unix seconds at completion of the bounded response measurement. Matches the value passed onchain. */
  observedAt: number;
  /** HTTP status observed, or 0 when no response arrived. */
  status: number;
  /** Wall-clock milliseconds until the bounded response body read completed (or the request failed). */
  latencyMs: number;
  /** Whether the observation satisfied every criterion in the guarantee policy. */
  healthy: boolean;
  /** Stable machine code for the outcome, e.g. "OK", "STATUS_MISMATCH", "TIMEOUT". */
  reason: string;
  /** keccak256 of the (bounded) response body. */
  bodyDigest: `0x${string}`;
}

/** keccak256 of a UTF-8 string. Used to fold variable-length fields into fixed-width slots. */
export function hashText(value: string): `0x${string}` {
  return keccak256(stringToBytes(value));
}

/** keccak256 of raw bytes, used for response bodies. */
export function hashBytes(value: Uint8Array): `0x${string}` {
  return keccak256(value);
}

/**
 * The exact ABI-encoded byte string that gets hashed into an evidence digest.
 *
 * Exported separately from {@link evidenceHash} so a test or an auditor can inspect the preimage rather than
 * having to trust that the digest was built from the fields they think it was.
 */
export function encodeEvidence(payload: EvidencePayload): `0x${string}` {
  return encodeAbiParameters(
    [
      { name: "domain", type: "bytes32" },
      { name: "guaranteeId", type: "uint256" },
      { name: "observationId", type: "bytes32" },
      { name: "urlHash", type: "bytes32" },
      { name: "observedAt", type: "uint64" },
      { name: "healthy", type: "bool" },
      { name: "status", type: "uint16" },
      { name: "latencyMs", type: "uint32" },
      { name: "bodyDigest", type: "bytes32" },
      { name: "reasonHash", type: "bytes32" },
    ],
    [
      EVIDENCE_DOMAIN,
      payload.guaranteeId,
      payload.observationId,
      hashText(payload.url),
      BigInt(payload.observedAt),
      payload.healthy,
      payload.status,
      payload.latencyMs,
      payload.bodyDigest,
      hashText(payload.reason),
    ],
  );
}

/** The evidence hash recorded onchain for an observation. */
export function evidenceHash(payload: EvidencePayload): `0x${string}` {
  return keccak256(encodeEvidence(payload));
}

/**
 * Deterministic observation id, derived from the guarantee and its scheduled slot.
 *
 * Not derived from a random value and not from the moment the probe ran. A monitor that crashes after
 * submitting onchain but before recording the result must, on retry, produce the same id - then the contract's
 * replay guard (`keccak256(abi.encode(guaranteeId, observationId))`) collapses the duplicate instead of
 * counting a second consecutive failure for one real outage and pulling a payout forward.
 *
 * The slot is normalised to milliseconds since the epoch before hashing. The database stores it as a
 * `timestamptz`, and different clients render the same instant differently (`Z` versus `+00:00`, varying
 * fractional-second precision); hashing the instant rather than its spelling keeps the id reproducible from
 * any correct rendering.
 */
export function observationId(guaranteeId: bigint, scheduledFor: string | Date): `0x${string}` {
  const slot = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  const ms = slot.getTime();
  if (!Number.isFinite(ms)) throw new Error(`INVALID_SLOT:${String(scheduledFor)}`);
  if (ms < 0) throw new Error("SLOT_BEFORE_EPOCH");

  return keccak256(encodeAbiParameters(
    [
      { name: "domain", type: "bytes32" },
      { name: "guaranteeId", type: "uint256" },
      { name: "slotMs", type: "uint64" },
    ],
    [OBSERVATION_DOMAIN, guaranteeId, BigInt(ms)],
  ));
}
