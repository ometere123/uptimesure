export function short(value?: string | null, left = 6, right = 4): string {
  if (!value) return "—";
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

export function usdc(raw: string | bigint | number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(String(raw || 0));
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} USDC`;
}

export function relativeDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function guaranteeStatus(active: boolean, withdrawn: boolean, expiresAt: string): "Protected" | "Exhausted" | "Expired" | "Withdrawn" {
  if (withdrawn) return "Withdrawn";
  if (new Date(expiresAt).getTime() <= Date.now()) return "Expired";
  return active ? "Protected" : "Exhausted";
}
