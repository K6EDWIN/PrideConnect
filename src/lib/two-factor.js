import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function secretKey() {
  const value = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (!value) throw new Error("TWO_FACTOR_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("TWO_FACTOR_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function hashKey() {
  const key = process.env.TWO_FACTOR_HASH_KEY || process.env.NEXTAUTH_SECRET;
  if (!key) throw new Error("NEXTAUTH_SECRET or TWO_FACTOR_HASH_KEY must be configured");
  return key;
}

export function generateBase32Secret(bytes = randomBytes(20)) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function encryptTotpSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptTotpSecret(payload) {
  if (!payload) throw new Error("Authenticator setup is missing");
  const [ivText, tagText, encryptedText] = payload.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Encrypted authenticator secret is invalid");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

function decodeBase32(value) {
  const input = String(value).toUpperCase().replace(/=+$/g, "");
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const character of input) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error("Invalid authenticator secret");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyTotp(secret, code, now = Date.now()) {
  return findTotpCounter(secret, code, now) !== null;
}

export function findTotpCounter(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const counter = Math.floor(now / 30_000);
  for (const window of [0, -1, 1]) {
    const matchingCounter = counter + window;
    if (matchingCounter >= 0 && safeEqual(hotp(secret, matchingCounter), code)) return matchingCounter;
  }
  return null;
}

export function hashTwoFactorCode(code) {
  return createHmac("sha256", hashKey()).update(String(code).trim().toUpperCase()).digest("hex");
}

export function hashChallengeToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function createChallengeToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashChallengeToken(token) };
}

export function createEmailCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function constantTimeHexEqual(left, right) {
  return /^[a-f0-9]{64}$/i.test(String(left)) && /^[a-f0-9]{64}$/i.test(String(right))
    && safeEqual(String(left).toLowerCase(), String(right).toLowerCase());
}

export function buildAuthenticatorUri({ secret, email }) {
  const label = encodeURIComponent(`PrideConnect:${email}`);
  const query = new URLSearchParams({ secret, issuer: "PrideConnect", algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query.toString()}`;
}
