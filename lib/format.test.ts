import { describe, expect, it } from "vitest";
import { guaranteeStatus, short, usdc } from "./format";

describe("format helpers", () => {
  it("formats six-decimal USDC integers", () => {
    expect(usdc(25_000_000n)).toBe("25 USDC");
    expect(usdc("1250001")).toBe("1.250001 USDC");
  });

  it("shortens long hashes without changing short text", () => {
    expect(short("0x1234567890abcdef", 6, 4)).toBe("0x1234…cdef");
    expect(short("short")).toBe("short");
  });

  it("distinguishes withdrawn and exhausted guarantees", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(guaranteeStatus(true, false, future)).toBe("Protected");
    expect(guaranteeStatus(false, false, future)).toBe("Exhausted");
    expect(guaranteeStatus(false, true, future)).toBe("Withdrawn");
  });
});
