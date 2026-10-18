import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function keyOf(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function seal(value: string, secret: string): string {
  if (!secret) throw new Error("SESSION_ENCRYPTION_KEY is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function unseal(value: string, secret: string): string {
  if (!secret) throw new Error("SESSION_ENCRYPTION_KEY is required");
  const [ivText, tagText, encryptedText] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}
