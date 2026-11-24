import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientAddress } from "@/lib/rate-limit";

describe("rate-limit client identity", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ignores caller-controlled forwarding headers outside a trusted proxy environment", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_X_REAL_IP", "");
    const request = new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.4", "x-real-ip": "198.51.100.5" },
    });
    expect(getClientAddress(request)).toBe("shared-untrusted-client-address");
  });

  it("uses Vercel's edge-provided x-real-ip and ignores x-forwarded-for", () => {
    vi.stubEnv("VERCEL", "1");
    const request = new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.4", "x-real-ip": "203.0.113.9" },
    });
    expect(getClientAddress(request)).toBe("203.0.113.9");
  });
});
