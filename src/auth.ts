import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { tenantForOwner } from "./rental/store.js";
import { getTenant } from "./rental/store.js";
import { unseal } from "./lib/crypto.js";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export interface OwnerRequest extends Request {
  ownerId?: number;
  tenantId?: string;
}

export interface InitDataUser {
  id: number;
}

export function verifyInitData(initData: string, botToken: string, maxAgeSec = 300, nowSec = Math.floor(Date.now() / 1000)): InitDataUser | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  const actual = Buffer.from(hash, "hex");
  const wanted = Buffer.from(expected, "hex");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || nowSec - authDate > maxAgeSec || authDate - nowSec > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: unknown } | null;
    return user && typeof user.id === "number" && Number.isSafeInteger(user.id) ? { id: user.id } : null;
  } catch {
    return null;
  }
}

export function ownerAuth(db: Database.Database) {
  return (req: OwnerRequest, res: Response, next: NextFunction): void => {
    const tenantId = Array.isArray(req.params.tenantId) ? req.params.tenantId[0] : req.params.tenantId;
    const standaloneOwner = tenantId ? db.prepare("SELECT telegramId FROM localUsers WHERE tenantId = ?").get(tenantId) as { telegramId: number } | undefined : undefined;
    if (standaloneOwner) {
      res.status(401).json({ error: "use the Telegram bot controls" });
      return;
    }
    const tenant = tenantId ? getTenant(db, tenantId) : undefined;
    if (!tenant) {
      res.status(403).json({ error: "tenant is not owned by this account" });
      return;
    }
    if (tenant.state === "cancelled" || tenant.state === "purged" || (tenant.state === "suspended" && tenant.suspendReason === "blocked")) {
      res.status(403).json({ error: "tenant is blocked" });
      return;
    }
    const stored = db.prepare("SELECT controlBotToken FROM tenants WHERE tenantId = ?").get(tenantId) as { controlBotToken: string | null };
    if (!stored?.controlBotToken) {
      res.status(503).json({ error: "control bot token is not provisioned" });
      return;
    }
    let botToken: string;
    try { botToken = unseal(stored.controlBotToken, config.sessionEncryptionKey); } catch { res.status(503).json({ error: "control bot authentication is unavailable" }); return; }
    const user = verifyInitData(req.header("x-telegram-init-data") ?? "", botToken);
    let ownerId = user?.id ?? 0;
    if (!user && config.ownerAuthFallback && config.ownerAuthSecret) {
      ownerId = Number(req.header("x-ads-owner-id"));
      const signature = req.header("x-ads-owner-signature") ?? "";
      const expected = createHmac("sha256", config.ownerAuthSecret).update(`${tenantId}:${ownerId}`).digest("hex");
      if (!Number.isSafeInteger(ownerId) || !equal(signature, expected)) ownerId = 0;
    }
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) {
      res.status(401).json({ error: "invalid Telegram Mini App authentication" });
      return;
    }
    if (ownerId !== tenant.ownerTelegramId || !tenantForOwner(db, tenantId, ownerId)) {
      res.status(403).json({ error: "tenant is not owned by this Telegram account" });
      return;
    }
    req.ownerId = ownerId;
    req.tenantId = tenantId;
    next();
  };
}
