import { Router, type Response } from "express";
import express from "express";
import type Database from "better-sqlite3";
import { bearerToken, CONTRACT_HEADER, CONTRACT_REVISION, CONTRACT_SHA256, secretMatches } from "./contract.js";
import { productManifest } from "./manifest.js";
import { applyDesired, allTenants, getTenant, parseDesired, runtimeState } from "./store.js";
import { lastFeedSyncAt, sequence } from "./sync.js";
import { config } from "../config.js";
import { refreshControlBotSecret } from "./secrets.js";

const fail = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message, retryable: status >= 500 } });
};

export function createRentalRouter(db: Database.Database): Router {
  const router = Router();
  router.use(express.json());
  router.use((req, res, next) => {
    res.setHeader(CONTRACT_HEADER, CONTRACT_REVISION);
    if (!config.rental || !config.rental.secrets.some((secret) => secretMatches(bearerToken(req.headers.authorization), secret))) return fail(res, 401, "unauthorized", "Bad or missing bearer token");
    next();
  });
  router.get("/manifest", (_req, res) => res.json(productManifest()));
  router.get("/health", (_req, res) => {
    const tenants = allTenants(db).filter((tenant) => tenant.productId === "ads");
    res.json({ ok: lastFeedSyncAt() !== null, contract: CONTRACT_REVISION, contractSha256: CONTRACT_SHA256, productId: "ads", tenantsDesired: tenants.filter((tenant) => tenant.state === "active").length, tenantsRunning: tenants.filter((tenant) => runtimeState(db, tenant).running).length, lastFeedSyncAt: lastFeedSyncAt(), seq: sequence() });
  });
  router.get("/tenants", (req, res) => {
    const requestedLimit = Number(req.query.limit ?? 100);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) return fail(res, 400, "bad_request", "limit must be an integer between 1 and 500");
    const limit = Math.min(500, requestedLimit);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const rows = allTenants(db).filter((tenant) => tenant.productId === "ads" && (cursor === null || tenant.tenantId > cursor)).slice(0, limit);
    res.json({ tenants: rows.map((tenant) => runtimeState(db, tenant)), nextCursor: rows.length === limit ? rows.at(-1)!.tenantId : null });
  });
  router.get("/tenants/:tenantId", (req, res) => {
    const tenant = getTenant(db, req.params.tenantId);
    if (!tenant || tenant.state === "purged") return fail(res, 404, "unknown_tenant", "No such tenant here");
    res.json(runtimeState(db, tenant));
  });
  router.put("/tenants/:tenantId", async (req, res) => {
    const desired = parseDesired(req.body);
    if (!desired || desired.tenantId !== req.params.tenantId || desired.productId !== "ads") return fail(res, 400, "bad_request", "Invalid ads desired state");
    const previous = getTenant(db, desired.tenantId);
    if (desired.expectData && !db.prepare("SELECT 1 FROM accounts WHERE tenantId = ?").get(desired.tenantId)) return fail(res, 409, "not_ready", "No tenant data held here");
    const verdict = applyDesired(db, desired);
    if (verdict === "stale") return fail(res, 409, "stale_version", `stored version ${previous?.version}`);
    if (desired.state === "purged") return res.status(verdict === "apply" ? 202 : 200).json({ tenantId: desired.tenantId, version: desired.version, running: false, applying: false, fault: null, usage: {}, hasData: false, observedAt: new Date().toISOString() });
    try {
      await refreshControlBotSecret(db, desired);
    } catch (error) {
      console.error(`ads secret sync failed for ${desired.tenantId}: ${String(error)}`);
    }
    res.status(verdict === "apply" ? 202 : 200).json(runtimeState(db, getTenant(db, desired.tenantId)!));
  });
  return router;
}
