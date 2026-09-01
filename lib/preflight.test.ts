import { describe, expect, it } from "vitest";
import { evaluatePreflight } from "../app/api/preflight/route";

const publicDns = async (_host: string, type: "A" | "AAAA") => type === "A" ? ["93.184.216.34"] : [];
const privateDns = async (_host: string, type: "A" | "AAAA") => type === "A" ? ["10.0.0.4"] : ["2001:db8::1"];

describe("frontend/monitor preflight policy parity", () => {
  it.each([
    "https://localhost/", "https://127.0.0.1/", "https://10.0.0.1/", "https://169.254.169.254/",
    "https://[::1]/", "https://[fc00::1]/", "https://[::ffff:127.0.0.1]/", "https://service.internal/",
    "https://user:pass@example.com/", "http://example.com/", "https://example.com:80/",
  ])("rejects %s exactly as the shared monitor URL validator", async (url) => {
    await expect(evaluatePreflight(url, publicDns)).rejects.toThrow();
  });

  it("rejects every address in a mixed DNS answer, not just the first", async () => {
    await expect(evaluatePreflight("https://mixed.example.com", async (_host, type) =>
      type === "A" ? ["93.184.216.34", "192.168.1.2"] : [])).rejects.toThrow("DNS_RESOLVES_TO_PRIVATE_IP");
  });

  it("accepts a public HTTPS target, advertises manual redirects, and never follows them", async () => {
    await expect(evaluatePreflight("https://status.example.com/health", publicDns)).resolves.toMatchObject({ ok: true, redirects: "manual" });
  });

  it("fails closed for private DNS and unresolved names", async () => {
    await expect(evaluatePreflight("https://status.example.com", privateDns)).rejects.toThrow("DNS_RESOLVES_TO_PRIVATE_IP");
    await expect(evaluatePreflight("https://missing.test.com", async () => { throw new Error("NXDOMAIN"); })).rejects.toThrow("DNS_NO_RECORDS");
  });
});
