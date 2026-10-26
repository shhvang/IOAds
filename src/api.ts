import express, { Router, type Response } from "express";
import type Database from "better-sqlite3";
import { ownerAuth, type OwnerRequest } from "./auth.js";
import { accountStatus, accounts, loginComplete, loginStart, logout, deleteAccount } from "./services/account.js";
import { syncGroups, setGroup, setGroupOverride } from "./services/groups.js";
import { addTarget, createCampaign, deleteCampaign, deleteTarget, detail, listCampaigns, setCampaignStatus, updateCampaign, updateTarget } from "./services/campaigns.js";
import { tierRank } from "./services/plans.js";

const failure = (res: Response, error: unknown): void => { res.status(400).json({ error: String(error instanceof Error ? error.message : error) }); };
const text = (value: string | string[]): string => Array.isArray(value) ? value[0] : value;
const bodyText = (value: unknown, field: string): string => { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`); return value; };
const id = (value: string | string[]): number => { const parsed = Number(text(value)); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid id"); return parsed; };

export function createApiRouter(db: Database.Database): Router {
  const router = Router();
  router.use(express.json({ limit: "32kb" }));
  router.use("/tenants/:tenantId", ownerAuth(db));

  router.get("/tenants/:tenantId/accounts", (req, res) => res.json({ data: accounts(db, req.params.tenantId) }));
  router.get("/tenants/:tenantId/account", (req, res) => res.json({ data: accountStatus(db, req.params.tenantId, typeof req.query.accountId === "string" ? req.query.accountId : undefined) }));
  router.post("/tenants/:tenantId/accounts/login", async (req: OwnerRequest, res) => { try { res.json(await loginStart(db, req.tenantId!, bodyText(req.body.phone, "phone"), req.body.accountId === undefined ? undefined : bodyText(req.body.accountId, "accountId"))); } catch (error) { failure(res, error); } });
  router.post("/tenants/:tenantId/accounts/:accountId/code", async (req: OwnerRequest, res) => { try { await loginComplete(db, req.tenantId!, bodyText(req.params.accountId, "accountId"), bodyText(req.body.phone, "phone"), bodyText(req.body.code, "code"), req.body.password === undefined ? undefined : bodyText(req.body.password, "password")); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.post("/tenants/:tenantId/accounts/:accountId/password", async (req: OwnerRequest, res) => { try { await loginComplete(db, req.tenantId!, bodyText(req.params.accountId, "accountId"), bodyText(req.body.phone, "phone"), bodyText(req.body.code, "code"), bodyText(req.body.password, "password")); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.post("/tenants/:tenantId/accounts/:accountId/logout", async (req: OwnerRequest, res) => { try { await logout(db, req.tenantId!, bodyText(req.params.accountId, "accountId")); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.delete("/tenants/:tenantId/accounts/:accountId", async (req: OwnerRequest, res) => { try { await deleteAccount(db, req.tenantId!, bodyText(req.params.accountId, "accountId")); res.status(204).end(); } catch (error) { failure(res, error); } });

  router.get("/tenants/:tenantId/groups", (req, res) => res.json({ data: db.prepare("SELECT tenantId, accountId, chatId, title, username, enabled, messageOverride, lastSentAt FROM groups WHERE tenantId = ? AND chatKind='group' AND (? IS NULL OR accountId = ?) ORDER BY title").all(req.params.tenantId, typeof req.query.accountId === "string" ? req.query.accountId : null, typeof req.query.accountId === "string" ? req.query.accountId : null) }));
  router.post("/tenants/:tenantId/groups/sync", async (req, res) => { try { res.json({ data: await syncGroups(db, req.params.tenantId, bodyText(req.body.accountId, "accountId")) }); } catch (error) { failure(res, error); } });
  router.patch("/tenants/:tenantId/groups/:accountId/:chatId", async (req: OwnerRequest, res) => { try { const tenant = db.prepare("SELECT tierCode FROM tenants WHERE tenantId = ?").get(req.tenantId) as { tierCode: string }; if (typeof req.body.enabled !== "boolean") throw new Error("enabled must be boolean"); await setGroup(db, req.tenantId!, text(req.params.accountId), text(req.params.chatId), req.body.enabled, req.body.messageOverride, tierRank(tenant.tierCode)); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.patch("/tenants/:tenantId/groups/:accountId/:chatId/override", (req: OwnerRequest, res) => { try { const tenant = db.prepare("SELECT tierCode FROM tenants WHERE tenantId = ?").get(req.tenantId) as { tierCode: string }; if (req.body.messageOverride !== null && typeof req.body.messageOverride !== "string") throw new Error("messageOverride must be a string or null"); setGroupOverride(db, req.tenantId!, text(req.params.accountId), text(req.params.chatId), req.body.messageOverride, tierRank(tenant.tierCode)); res.status(204).end(); } catch (error) { failure(res, error); } });

  router.get("/tenants/:tenantId/campaigns", (req, res) => res.json({ data: listCampaigns(db, req.params.tenantId) }));
  router.post("/tenants/:tenantId/campaigns", (req, res) => { try { res.status(201).json({ data: createCampaign(db, req.params.tenantId, req.body) }); } catch (error) { failure(res, error); } });
  router.get("/tenants/:tenantId/campaigns/:id", (req, res) => res.json({ data: detail(db, req.params.tenantId, id(req.params.id)) }));
  router.patch("/tenants/:tenantId/campaigns/:id", (req, res) => { try { res.json({ data: updateCampaign(db, req.params.tenantId, id(req.params.id), req.body) }); } catch (error) { failure(res, error); } });
  router.delete("/tenants/:tenantId/campaigns/:id", (req, res) => { try { deleteCampaign(db, req.params.tenantId, id(req.params.id)); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.post("/tenants/:tenantId/campaigns/:id/schedule", (req, res) => { try { setCampaignStatus(db, req.params.tenantId, id(req.params.id), "scheduled"); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.post("/tenants/:tenantId/campaigns/:id/pause", (req, res) => { try { setCampaignStatus(db, req.params.tenantId, id(req.params.id), "paused"); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.post("/tenants/:tenantId/campaigns/:id/cancel", (req, res) => { try { setCampaignStatus(db, req.params.tenantId, id(req.params.id), "cancelled"); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.post("/tenants/:tenantId/campaigns/:id/targets", async (req, res) => { try { await addTarget(db, req.params.tenantId, id(req.params.id), bodyText(req.body.chatId, "chatId"), req.body.accountId === undefined ? undefined : bodyText(req.body.accountId, "accountId")); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.patch("/tenants/:tenantId/campaigns/:id/targets/:chatId", (req, res) => { try { updateTarget(db, req.params.tenantId, id(req.params.id), text(req.params.chatId), req.body.enabled, req.body.accountId === undefined ? undefined : bodyText(req.body.accountId, "accountId")); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.delete("/tenants/:tenantId/campaigns/:id/targets/:chatId", (req, res) => { try { deleteTarget(db, req.params.tenantId, id(req.params.id), text(req.params.chatId), typeof req.query.accountId === "string" ? req.query.accountId : undefined); res.status(204).end(); } catch (error) { failure(res, error); } });
  router.get("/tenants/:tenantId/deliveries", (req, res) => res.json({ data: db.prepare("SELECT * FROM deliveries WHERE tenantId = ? ORDER BY id DESC LIMIT 200").all(req.params.tenantId) }));
  return router;
}
