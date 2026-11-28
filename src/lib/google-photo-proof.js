import { createHmac, timingSafeEqual } from "node:crypto";

function isGooglePhotoUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"));
  } catch {
    return false;
  }
}

function proofFor(challengeToken, imageUrl) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not configured");
  return createHmac("sha256", secret)
    .update(`${challengeToken}\0${imageUrl}`)
    .digest("hex");
}

export function createGooglePhotoProof(challengeToken, imageUrl) {
  if (!isGooglePhotoUrl(imageUrl)) return null;
  return proofFor(challengeToken, imageUrl);
}

export function verifyGooglePhotoProof(challengeToken, imageUrl, proof) {
  if (!isGooglePhotoUrl(imageUrl) || typeof proof !== "string" || !/^[a-f0-9]{64}$/i.test(proof)) return false;
  const expected = Buffer.from(proofFor(challengeToken, imageUrl), "hex");
  const actual = Buffer.from(proof, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
