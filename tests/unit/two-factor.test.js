import { afterEach, describe, expect, it } from "vitest";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  findTotpCounter,
  generateBase32Secret,
  hashChallengeToken,
  verifyTotp,
} from "@/lib/two-factor";
import { createGooglePhotoProof, verifyGooglePhotoProof } from "@/lib/google-photo-proof";

describe("two-factor primitives", () => {
  afterEach(() => {
    delete process.env.TWO_FACTOR_ENCRYPTION_KEY;
    delete process.env.TWO_FACTOR_HASH_KEY;
    delete process.env.NEXTAUTH_SECRET;
  });

  it("matches the RFC 6238 six-digit vector with a 30-second clock step", () => {
    // RFC test secret "12345678901234567890" encoded as Base32.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(findTotpCounter(secret, "287082", 59_000)).toBe(1);
    expect(verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(secret, "287083", 59_000)).toBe(false);
    expect(verifyTotp(secret, "12345", 59_000)).toBe(false);
  });

  it("generates secrets in the authenticator-compatible Base32 alphabet", () => {
    const secret = generateBase32Secret(Buffer.from("\x01\x02\x03\x04", "binary"));
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThan(0);
  });

  it("encrypts authenticator secrets with authenticated encryption and decrypts them", () => {
    process.env.TWO_FACTOR_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
    const encrypted = encryptTotpSecret("private-base32-secret");
    expect(encrypted).not.toContain("private-base32-secret");
    expect(decryptTotpSecret(encrypted)).toBe("private-base32-secret");
    expect(() => decryptTotpSecret(`${encrypted.slice(0, -3)}bad`)).toThrow();
  });

  it("stores only a one-way hash of challenge tokens", () => {
    expect(hashChallengeToken("token-one")).not.toBe("token-one");
    expect(hashChallengeToken("token-one")).toBe(hashChallengeToken("token-one"));
    expect(hashChallengeToken("token-one")).not.toBe(hashChallengeToken("token-two"));
  });

  it("binds a Google profile image to the specific two-factor challenge", () => {
    process.env.NEXTAUTH_SECRET = "test-only-secret";
    const token = "challenge-token-one";
    const image = "https://lh3.googleusercontent.com/member-photo";
    const proof = createGooglePhotoProof(token, image);

    expect(verifyGooglePhotoProof(token, image, proof)).toBe(true);
    expect(verifyGooglePhotoProof("another-challenge", image, proof)).toBe(false);
    expect(verifyGooglePhotoProof(token, "https://attacker.example/photo.png", proof)).toBe(false);
  });
});
