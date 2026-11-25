import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";

describe("global HTTP security headers", () => {
  it("sets safe defaults for application and public routes", async () => {
    const rules = await nextConfig.headers();
    const globalRule = rules.find((rule) => rule.source === "/:path*");
    const headers = Object.fromEntries(globalRule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
  });
});
