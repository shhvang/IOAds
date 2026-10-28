import { InputFile, type Bot, type Context } from "grammy";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { now } from "./db.js";
import { back, button, editRich, escapeHtml, menu, replyRich, richHtml, type Button } from "./bot-ui.js";
import { reusableRichMessage } from "./inline.js";
import { setCampaignStatus } from "./services/campaigns.js";
import { broadcastAudienceCounts, createAdminBroadcast, grantStandalonePlan, logAdmin, runAdminBroadcastOnce, setAdminBroadcastStatus, setUserBlocked, startAdminBroadcast, type Audience } from "./services/admin.js";
import { workerPoolStatus } from "./services/worker-pool.js";
import { schedulerProcessStatus } from "./services/scheduler-process.js";
import { lastFeedSyncAt } from "./rental/sync.js";
import { seal, unseal } from "./lib/crypto.js";
import { adapterFor, refreshAccountProfile } from "./services/account.js";

const e = escapeHtml;
const pageSize = 7;
const short = (value: unknown, length = 42) => String(value ?? "").slice(0, length);
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "—";
const n = (db: Database.Database, query: string, ...args: unknown[]): number => (db.prepare(query).get(...args) as { n: number }).n;
type User = { telegramId: number; tenantId: string; tierCode: string; paidUntil: string | null; blocked: number; username: string | null; displayName: string | null; createdAt: string };
type Tenant = { rowId: number; tenantId: string; ownerId: number; productId: string; state: string; tierCode: string; runtime: string; fault: string | null; updatedAt: string };
type Campaign = { id: number; tenantId: string; name: string; status: string; nextRunAt: string | null; senderAccountId: string };
type DirectoryGroup = { chatId: string; title: string; username: string | null; inviteCipher: string | null; firstSeenAt: string; lastSeenAt: string };

export function telegramProfileLink(username: string | null, id: number, phone?: string | null): string {
  if (username && /^[A-Za-z0-9_]{4,32}$/.test(username)) return `https://t.me/${username}`;
  if (phone && /^\+[1-9]\d{6,14}$/.test(phone)) return `https://t.me/${phone}`;
  return `tg://user?id=${id}`;
}

export function groupLink(group: Pick<DirectoryGroup, "username" | "inviteCipher">): string | null {
  if (group.username && /^[A-Za-z0-9_]{4,32}$/.test(group.username)) return `https://t.me/${group.username}`;
  if (!group.inviteCipher || !config.sessionEncryptionKey) return null;
  try {
    const url = unseal(group.inviteCipher, config.sessionEncryptionKey);
    return /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+)$/.test(url) ? url : null;
  } catch { return null; }
}

export function registerAdminBot(bot: Bot, db: Database.Database, onUserBlocked?: (userId: number) => void): void {
  let userSearch = "", tenantSearch = "", failureSearch = "";
  const requireAdmin = (ctx: Context): boolean => ctx.from?.id === config.adminTelegramId && ctx.chat?.type === "private";
  const flow = () => db.prepare("SELECT action FROM adminFlow WHERE actorId=? AND updatedAt>=?")
    .get(config.adminTelegramId, new Date(Date.now() - 30 * 60_000).toISOString()) as { action: string } | undefined;
  const setFlow = (action: string | null) => {
    if (!action) db.prepare("DELETE FROM adminFlow WHERE actorId=?").run(config.adminTelegramId);
    else db.prepare("INSERT INTO adminFlow(actorId,action,updatedAt) VALUES(?,?,?) ON CONFLICT(actorId) DO UPDATE SET action=excluded.action,updatedAt=excluded.updatedAt")
      .run(config.adminTelegramId, action, now());
  };
  const render = (ctx: Context, html: string, rows: Button[][]) => ctx.callbackQuery
    ? editRich(ctx, html, { parse_mode: "HTML", reply_markup: menu(rows) })
    : replyRich(ctx, html, { parse_mode: "HTML", reply_markup: menu(rows) });
  const nav = () => [back("a:home", "Admin home")];
  const userName = (user: Pick<User, "displayName" | "username" | "createdAt">) => user.displayName || (user.username ? `@${user.username}` : `Bot user · ${date(user.createdAt).split(",")[0]}`);
  const tenant = (rowId: number): Tenant | undefined => db.prepare("SELECT rowid AS rowId,tenantId,ownerId,productId,state,tierCode,runtime,fault,updatedAt FROM tenants WHERE rowid=?").get(rowId) as Tenant | undefined;

  async function dashboard(ctx: Context): Promise<unknown> {
    setFlow(null);
    const users = n(db, "SELECT COUNT(*) AS n FROM localUsers");
    const blockedUsers = n(db, "SELECT COUNT(*) AS n FROM localUsers WHERE blocked=1");
    const tenants = n(db, "SELECT COUNT(*) AS n FROM tenants");
    const connected = n(db, "SELECT COUNT(*) AS n FROM accounts WHERE status='active' AND session IS NOT NULL");
    const scheduled = n(db, "SELECT COUNT(*) AS n FROM campaigns WHERE status='scheduled'");
    const sent = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status='sent' AND sentAt>=date('now')");
    const failed = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('failed','retry')");
    const workers = workerPoolStatus();
    const scheduler = schedulerProcessStatus();
    const ongoing = n(db, "SELECT COUNT(*) AS n FROM adminBroadcasts WHERE status IN ('running','paused')");
    return render(ctx, `<h2>IOAds admin</h2><p>Service overview</p><table compact><tr><td>Bot users</td><td>${users}</td></tr><tr><td>Blocked users</td><td>${blockedUsers}</td></tr><tr><td>Tenants</td><td>${tenants}</td></tr><tr><td>Connected accounts</td><td>${connected}</td></tr><tr><td>Scheduled campaigns</td><td>${scheduled}</td></tr><tr><td>Campaign sends today</td><td>${sent}</td></tr><tr><td>Failed / retrying</td><td>${failed}</td></tr><tr><td>Scheduler</td><td>${scheduler.running ? "Running" : "Down"}</td></tr><tr><td>Sender workers</td><td>${workers.filter((w) => w.running).length} / ${workers.length}</td></tr><tr><td>Active broadcasts</td><td>${ongoing}</td></tr></table><p>Rental feed: ${e(date(lastFeedSyncAt()))}</p>`, [
      [button("Users & premium", "a:users:0", "primary", "people"), button("Tenants", "a:tenants:0", undefined, "people")],
      [button("Accounts", "a:accounts:0"), button("Campaigns", "a:campaigns:0")],
      [button("All groups", "a:directory:0", "primary"), button("Export group links", "a:exportgroups")],
      [button("Delivery failures", "a:failures:0", undefined, "warning"), button("Broadcasts", "a:broadcasts:0", undefined, "megaphone")],
      [button("Audit", "a:audit:0"), button("Refresh", "a:home", "link", "refresh")],
      [back("home", "Public home")],
    ]);
  }

  async function users(ctx: Context, requested = 0): Promise<unknown> {
    const pattern = `%${userSearch}%`;
    const where = userSearch ? "WHERE COALESCE(username,'') LIKE ? OR COALESCE(displayName,'') LIKE ?" : "";
    const args = userSearch ? [pattern, pattern] : [];
    const total = n(db, `SELECT COUNT(*) AS n FROM localUsers ${where}`, ...args);
    const page = Math.min(Math.max(requested, 0), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT telegramId,tenantId,tierCode,paidUntil,blocked,username,displayName,createdAt FROM localUsers ${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, page * pageSize) as User[];
    await Promise.allSettled(rows.filter((user) => !user.displayName).map(async (user) => {
      const chat = await ctx.api.getChat(user.telegramId);
      if (chat.type !== "private") return;
      user.displayName = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || null;
      user.username = chat.username ?? null;
      db.prepare("UPDATE localUsers SET username=?,displayName=? WHERE telegramId=?")
        .run(user.username, user.displayName, user.telegramId);
    }));
    const buttons: Button[][] = rows.map((user) => [button(`${short(userName(user), 27)} · ${user.blocked ? "blocked" : user.tierCode}`, `a:u:${user.telegramId}`)]);
    buttons.push([button("Search by name", "a:search:users", "primary"), button("Clear search", "a:clear:users")]);
    buttons.push([...(page ? [button("Previous", `a:users:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `a:users:${page + 1}`, undefined, "next")] : [])]);
    buttons.push(nav());
    return render(ctx, `<h2>Bot users</h2><p>${total} matching${userSearch ? ` · search: ${e(userSearch)}` : ""}. Choose a person to inspect or grant premium.</p>`, buttons);
  }

  async function showUser(ctx: Context, userId: number): Promise<unknown> {
    let user = db.prepare("SELECT telegramId,tenantId,tierCode,paidUntil,blocked,username,displayName,createdAt FROM localUsers WHERE telegramId=?").get(userId) as User | undefined;
    if (!user) return users(ctx);
    try {
      const chat = await ctx.api.getChat(user.telegramId);
      if (chat.type === "private") {
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
        db.prepare("UPDATE localUsers SET username=?,displayName=? WHERE telegramId=?").run(chat.username ?? null, name || null, userId);
        user = { ...user, username: chat.username ?? null, displayName: name || null };
      }
    } catch { /* The user may have blocked the bot. */ }
    const accountCount = n(db, "SELECT COUNT(*) AS n FROM accounts WHERE tenantId=? AND status='active'", user.tenantId);
    const campaignCount = n(db, "SELECT COUNT(*) AS n FROM campaigns WHERE tenantId=? AND status='scheduled'", user.tenantId);
    const sent = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE tenantId=? AND status='sent' AND sentAt>=date('now')", user.tenantId);
    const tenantRow = db.prepare("SELECT rowid AS rowId FROM tenants WHERE tenantId=?").get(user.tenantId) as { rowId: number } | undefined;
    return render(ctx, `<h2>${e(userName(user))}</h2><p>Username: ${user.username ? `@${e(user.username)}` : "none"}<br/>Telegram ID: ${user.telegramId}<br/>Access: <b>${user.blocked ? "Blocked" : "Active"}</b><br/>Plan: <b>${e(user.tierCode)}</b><br/>Paid until: ${e(date(user.paidUntil))}<br/>Connected accounts: ${accountCount}<br/>Scheduled campaigns: ${campaignCount}<br/>Sends today: ${sent}</p>`, [
      [{ text: "Open user in Telegram", url: telegramProfileLink(user.username, user.telegramId) }],
      [button("Grant Pro", `a:grant:${userId}:pro`, "success", "card"), button("Grant Business", `a:grant:${userId}:business`, "success", "card")],
      ...(user.tierCode !== "free" ? [[button("Revoke premium", `a:revoke:${userId}`, "danger")]] : []),
      ...(userId !== config.adminTelegramId ? [[button(user.blocked ? "Unblock user" : "Block user & userbots", `a:blockconfirm:${userId}:${user.blocked ? 0 : 1}`, user.blocked ? "success" : "danger")]] : []),
      ...(tenantRow ? [[button("Tenant detail", `a:t:${tenantRow.rowId}`)]] : []),
      [back("a:users:0", "Back to users")],
    ]);
  }

  async function tenants(ctx: Context, requested = 0): Promise<unknown> {
    const pattern = `%${tenantSearch}%`;
    const where = tenantSearch ? "WHERE t.tenantId LIKE ? OR COALESCE(u.username,'') LIKE ? OR COALESCE(u.displayName,'') LIKE ?" : "";
    const args = tenantSearch ? [pattern, pattern, pattern] : [];
    const from = "FROM tenants t LEFT JOIN localUsers u ON u.tenantId=t.tenantId";
    const total = n(db, `SELECT COUNT(*) AS n ${from} ${where}`, ...args);
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT t.rowid AS rowId,t.tenantId,t.ownerId,t.productId,t.state,t.tierCode,t.runtime,t.fault,t.updatedAt,u.username,u.displayName ${from} ${where} ORDER BY t.updatedAt DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, page * pageSize) as Array<Tenant & { username: string | null; displayName: string | null }>;
    const buttons: Button[][] = rows.map((row) => [button(`${short(row.displayName || (row.username ? `@${row.username}` : row.tenantId), 29)} · ${row.state}`, `a:t:${row.rowId}`)]);
    buttons.push([button("Search tenants", "a:search:tenants", "primary"), button("Clear search", "a:clear:tenants")]);
    buttons.push([...(page ? [button("Previous", `a:tenants:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `a:tenants:${page + 1}`, undefined, "next")] : [])]);
    buttons.push(nav());
    return render(ctx, `<h2>Tenants</h2><p>${total} matching${tenantSearch ? ` · search: ${e(tenantSearch)}` : ""}. Subscriptions and suspension are managed by the rental hub.</p>`, buttons);
  }

  async function showTenant(ctx: Context, rowId: number): Promise<unknown> {
    const row = tenant(rowId);
    if (!row) return tenants(ctx);
    const user = db.prepare("SELECT displayName,username,blocked FROM localUsers WHERE tenantId=?").get(row.tenantId) as { displayName: string | null; username: string | null; blocked: number } | undefined;
    const accounts = n(db, "SELECT COUNT(*) AS n FROM accounts WHERE tenantId=? AND status='active' AND session IS NOT NULL", row.tenantId);
    const groups = n(db, "SELECT COUNT(*) AS n FROM groups WHERE tenantId=? AND enabled=1 AND chatKind='group'", row.tenantId);
    const campaigns = n(db, "SELECT COUNT(*) AS n FROM campaigns WHERE tenantId=? AND status='scheduled'", row.tenantId);
    const sent = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE tenantId=? AND status='sent' AND sentAt>=date('now')", row.tenantId);
    const failed = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE tenantId=? AND status IN ('failed','retry')", row.tenantId);
    return render(ctx, `<h2>${e(user?.displayName || (user?.username ? `@${user.username}` : row.tenantId))}</h2><p>${e(row.productId)} · ${e(row.state)} · ${e(row.tierCode)}${user?.blocked ? " · <b>blocked by admin</b>" : ""}<br/>Runtime: ${e(row.runtime)}<br/>Connected accounts: ${accounts}<br/>Enabled groups: ${groups}<br/>Scheduled campaigns: ${campaigns}<br/>Sends today: ${sent}<br/>Failures / retries: ${failed}${row.fault ? `<br/>Fault: ${e(short(row.fault, 180))}` : ""}</p>`, [
      [{ text: "Open owner in Telegram", url: telegramProfileLink(user?.username ?? null, row.ownerId) }],
      [button("Accounts", `a:ta:${rowId}:0`), button("Groups", `a:tg:${rowId}:0`)],
      [button("Campaigns", `a:tc:${rowId}:0`), button("Failures", `a:tf:${rowId}:0`, undefined, "warning")],
      [back("a:tenants:0", "Back to tenants")],
    ]);
  }

  async function accounts(ctx: Context, requested = 0, rowId?: number): Promise<unknown> {
    const t = rowId ? tenant(rowId) : undefined;
    const where = t ? "WHERE a.tenantId=?" : "";
    const args = t ? [t.tenantId] : [];
    const total = n(db, `SELECT COUNT(*) AS n FROM accounts a ${where}`, ...args);
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT a.rowid AS rowId,a.tenantId,a.displayName,a.status,a.phone,a.sendAfter,t.rowid AS tenantRow FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId ${where} ORDER BY CASE a.status WHEN 'connecting' THEN 0 WHEN 'logged_out' THEN 1 WHEN 'limit_paused' THEN 2 ELSE 3 END,a.updatedAt DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, page * pageSize) as Array<{ rowId: number; tenantId: string; displayName: string | null; status: string; phone: string | null; sendAfter: string | null; tenantRow: number }>;
    const buttons: Button[][] = rows.map((row) => [button(`${short(row.displayName || row.phone || "Account", 29)} · ${row.status}`, `a:acc:${row.rowId}`)]);
    const prefix = t ? `a:ta:${rowId}` : "a:accounts";
    buttons.push([...(page ? [button("Previous", `${prefix}:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `${prefix}:${page + 1}`, undefined, "next")] : [])]);
    buttons.push([back(t ? `a:t:${rowId}` : "a:home", t ? "Back to tenant" : "Admin home")]);
    return render(ctx, `<h2>Accounts</h2><p>${total} accounts. Login, limit, and rate limit state are shown per account.</p>`, buttons);
  }

  async function showAccount(ctx: Context, rowId: number): Promise<unknown> {
    let a = db.prepare("SELECT a.tenantId,a.accountId,a.displayName,a.username,a.telegramUserId,a.phone,a.status,a.sendAfter,a.updatedAt,t.rowid AS tenantRow FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId WHERE a.rowid=?")
      .get(rowId) as { tenantId: string; accountId: string; displayName: string | null; username: string | null; telegramUserId: number | null; phone: string | null; status: string; sendAfter: string | null; updatedAt: string; tenantRow: number } | undefined;
    if (!a) return accounts(ctx);
    if (a.status === "active" && !a.username) {
      try {
        await refreshAccountProfile(db, a.tenantId, a.accountId);
        a = db.prepare("SELECT a.tenantId,a.accountId,a.displayName,a.username,a.telegramUserId,a.phone,a.status,a.sendAfter,a.updatedAt,t.rowid AS tenantRow FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId WHERE a.rowid=?").get(rowId) as typeof a;
      } catch { /* Saved identity remains available if Telegram is offline. */ }
    }
    if (!a) return accounts(ctx);
    const groups = n(db, "SELECT COUNT(*) AS n FROM groups WHERE tenantId=? AND accountId=? AND enabled=1 AND chatKind='group'", a.tenantId, a.accountId);
    const failed = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE tenantId=? AND accountId=? AND status IN ('failed','retry')", a.tenantId, a.accountId);
    return render(ctx, `<h2>${e(a.displayName || a.phone || "Telegram account")}</h2><p>Username: ${a.username ? `@${e(a.username)}` : "none"}<br/>Telegram ID: ${a.telegramUserId ?? "unknown"}<br/>Status: ${e(a.status)}<br/>Enabled groups: ${groups}<br/>Failed / retrying deliveries: ${failed}<br/>Rate limit ends: ${e(date(a.sendAfter))}<br/>Updated: ${e(date(a.updatedAt))}</p>`, [...(a.telegramUserId ? [[{ text: "Open userbot in Telegram", url: telegramProfileLink(a.username, a.telegramUserId, a.phone) }]] : []), [button("Groups", `a:ag:${rowId}:0`), button("Failures", `a:af:${rowId}:0`)], [button("Tenant", `a:t:${a.tenantRow}`)], [back("a:accounts:0", "Back to accounts")]]);
  }

  async function groups(ctx: Context, requested = 0, tenantRow?: number, accountRow?: number): Promise<unknown> {
    const t = tenantRow ? tenant(tenantRow) : undefined;
    const a = accountRow ? db.prepare("SELECT accountId,tenantId FROM accounts WHERE rowid=?").get(accountRow) as { accountId: string; tenantId: string } | undefined : undefined;
    if (!t && !a) return tenants(ctx);
    const where = a ? "WHERE g.tenantId=? AND g.accountId=? AND g.chatKind='group'" : "WHERE g.tenantId=? AND g.chatKind='group'";
    const args = a ? [a.tenantId, a.accountId] : [t!.tenantId];
    const total = n(db, `SELECT COUNT(*) AS n FROM groups g ${where}`, ...args);
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT g.rowid AS rowId,g.title,g.enabled,g.lastSentAt,a.displayName FROM groups g JOIN accounts a ON a.tenantId=g.tenantId AND a.accountId=g.accountId ${where} ORDER BY g.enabled DESC,g.title LIMIT ? OFFSET ?`)
      .all(...args, pageSize, page * pageSize) as Array<{ rowId: number; title: string; enabled: number; lastSentAt: string | null; displayName: string | null }>;
    const buttons: Button[][] = rows.map((row) => [button(`${row.enabled ? "✓ " : "○ "}${short(row.title, 38)}`, `a:g:${row.rowId}`)]);
    const prefix = a ? `a:ag:${accountRow}` : `a:tg:${tenantRow}`;
    buttons.push([...(page ? [button("Previous", `${prefix}:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `${prefix}:${page + 1}`, undefined, "next")] : [])]);
    buttons.push([back(a ? `a:acc:${accountRow}` : `a:t:${tenantRow}`, a ? "Back to account" : "Back to tenant")]);
    return render(ctx, `<h2>Groups</h2><p>${total} synced groups. A check means that group is enabled for its account.</p>`, buttons);
  }

  async function showGroup(ctx: Context, rowId: number): Promise<unknown> {
    const g = db.prepare("SELECT g.tenantId,g.accountId,g.chatId,g.title,g.username,g.enabled,g.lastSentAt,a.rowid AS accountRow,t.rowid AS tenantRow FROM groups g JOIN accounts a ON a.tenantId=g.tenantId AND a.accountId=g.accountId JOIN tenants t ON t.tenantId=g.tenantId WHERE g.rowid=?")
      .get(rowId) as { tenantId: string; accountId: string; chatId: string; title: string; username: string | null; enabled: number; lastSentAt: string | null; accountRow: number; tenantRow: number } | undefined;
    if (!g) return tenants(ctx);
    const targets = n(db, "SELECT COUNT(*) AS n FROM campaignTargets WHERE tenantId=? AND accountId=? AND chatId=? AND enabled=1", g.tenantId, g.accountId, g.chatId);
    const failed = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE tenantId=? AND accountId=? AND chatId=? AND status IN ('failed','retry')", g.tenantId, g.accountId, g.chatId);
    const directory = db.prepare("SELECT username,inviteCipher FROM groupDirectory WHERE chatId=?").get(g.chatId) as Pick<DirectoryGroup, "username" | "inviteCipher"> | undefined;
    const link = directory ? groupLink(directory) : null;
    return render(ctx, `<h2>${e(g.title)}</h2><p>Username: ${g.username ? `@${e(g.username)}` : "none"}<br/>Chat ID: ${e(g.chatId)}<br/>${g.enabled ? "Enabled" : "Disabled"}<br/>Campaign selections: ${targets}<br/>Failed / retrying sends: ${failed}<br/>Last sent: ${e(date(g.lastSentAt))}</p>`, [...(link ? [[{ text: "Open group in Telegram", url: link }]] : []), [button("Account", `a:acc:${g.accountRow}`), button("Tenant", `a:t:${g.tenantRow}`)], [back(`a:ag:${g.accountRow}:0`, "Back to groups")]]);
  }

  async function directory(ctx: Context, requested = 0): Promise<unknown> {
    const total = n(db, "SELECT COUNT(*) AS n FROM groupDirectory");
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare("SELECT chatId,title,username,inviteCipher,firstSeenAt,lastSeenAt FROM groupDirectory ORDER BY lastSeenAt DESC,chatId LIMIT ? OFFSET ?")
      .all(pageSize, page * pageSize) as DirectoryGroup[];
    const buttons: Button[][] = rows.map((g) => [button(`${short(g.title, 30)}${g.username ? ` · @${short(g.username, 17)}` : ""}`, `a:dg:${g.chatId}:${page}`)]);
    buttons.push([button("Export .txt", "a:exportgroups", "primary"), button("Refresh links", "a:refreshgroups")]);
    buttons.push([...(page ? [button("Previous", `a:directory:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `a:directory:${page + 1}`, undefined, "next")] : [])]);
    buttons.push(nav());
    return render(ctx, `<h2>All groups</h2><p>${total} unique groups ever recorded. Public usernames and available private invite links can be opened. An older private link may have expired or been revoked.</p>`, buttons);
  }

  async function refreshMissingGroupLinks(): Promise<void> {
    if (!config.telegramApiId || !config.telegramApiHash || !config.sessionEncryptionKey) return;
    const sources = db.prepare(`SELECT DISTINCT a.tenantId,a.accountId FROM groups g
      JOIN accounts a ON a.tenantId=g.tenantId AND a.accountId=g.accountId
      JOIN groupDirectory d ON d.chatId=g.chatId
      WHERE g.chatKind='group' AND d.username IS NULL AND d.inviteCipher IS NULL
        AND a.status='active' AND a.session IS NOT NULL AND a.telegramUserId IS NOT NULL`)
      .all() as Array<{ tenantId: string; accountId: string }>;
    for (let offset = 0; offset < sources.length; offset += 3) {
      await Promise.allSettled(sources.slice(offset, offset + 3).map(async (source) => {
        const dialogs = await adapterFor(db, source.tenantId, source.accountId).dialogs();
        const known = new Set((db.prepare("SELECT chatId FROM groups WHERE tenantId=? AND accountId=? AND chatKind='group'").all(source.tenantId, source.accountId) as Array<{ chatId: string }>).map((g) => g.chatId));
        const update = db.prepare("UPDATE groupDirectory SET title=?,username=COALESCE(?,username),inviteCipher=COALESCE(?,inviteCipher),lastSeenAt=? WHERE chatId=?");
        db.transaction(() => {
          for (const g of dialogs) {
            if (g.kind !== "group" || !known.has(g.chatId)) continue;
            update.run(g.title, g.username, g.inviteLink ? seal(g.inviteLink, config.sessionEncryptionKey) : null, now(), g.chatId);
          }
        })();
      }));
    }
  }

  async function directoryGroup(ctx: Context, chatId: string, page = 0): Promise<unknown> {
    const g = db.prepare("SELECT chatId,title,username,inviteCipher,firstSeenAt,lastSeenAt FROM groupDirectory WHERE chatId=?").get(chatId) as DirectoryGroup | undefined;
    if (!g) return directory(ctx, page);
    const current = n(db, "SELECT COUNT(*) AS n FROM groups WHERE chatId=? AND chatKind='group'", chatId);
    const enabled = n(db, "SELECT COUNT(*) AS n FROM groups WHERE chatId=? AND chatKind='group' AND enabled=1", chatId);
    const campaigns = n(db, "SELECT COUNT(*) AS n FROM campaignTargets WHERE chatId=?", chatId);
    const accounts = db.prepare("SELECT a.rowid AS rowId,COALESCE(a.displayName,a.username,a.phone,'Userbot') AS name FROM groups g JOIN accounts a ON a.tenantId=g.tenantId AND a.accountId=g.accountId WHERE g.chatId=? AND g.chatKind='group' ORDER BY g.updatedAt DESC LIMIT 3")
      .all(chatId) as Array<{ rowId: number; name: string }>;
    const link = groupLink(g);
    return render(ctx, `<h2>${e(g.title)}</h2><p>Username: ${g.username ? `@${e(g.username)}` : "none"}<br/>Chat ID: ${e(g.chatId)}<br/>First recorded: ${e(date(g.firstSeenAt))}<br/>Last recorded: ${e(date(g.lastSeenAt))}<br/>Current userbots: ${current}<br/>Enabled userbots: ${enabled}<br/>Current campaign selections: ${campaigns}<br/>Link: ${link ? "available" : "no public or accessible invite link"}</p>`, [
      ...(link ? [[{ text: "Open group in Telegram", url: link }]] : []),
      ...accounts.map((a) => [button(`Userbot · ${short(a.name, 30)}`, `a:acc:${a.rowId}`)]),
      [back(`a:directory:${page}`, "Back to all groups")],
    ]);
  }

  async function exportGroups(ctx: Context): Promise<void> {
    const missing = n(db, "SELECT COUNT(*) AS n FROM groupDirectory WHERE username IS NULL AND inviteCipher IS NULL");
    if (missing) await ctx.reply(`Checking connected userbots for links to ${missing} groups. I’ll send the text file when it is ready.`);
    await refreshMissingGroupLinks();
    const groups = db.prepare("SELECT chatId,title,username,inviteCipher,firstSeenAt,lastSeenAt FROM groupDirectory ORDER BY title COLLATE NOCASE,chatId").all() as DirectoryGroup[];
    const lines = ["IOAds groups", `Exported: ${now()}`, `Unique groups: ${groups.length}`, "", ...groups.flatMap((g, index) => [
      `${index + 1}. ${g.title.replace(/[\r\n]+/g, " ")}`,
      `Username: ${g.username ? `@${g.username}` : "none"}`,
      `Chat ID: ${g.chatId}`,
      `Link: ${groupLink(g) ?? "unavailable (private group; no accessible invite link)"}`,
      `First recorded: ${g.firstSeenAt}`,
      `Last recorded: ${g.lastSeenAt}`,
      "",
    ])];
    await ctx.api.sendDocument(config.adminTelegramId, new InputFile(Buffer.from(lines.join("\n"), "utf8"), `ioads-groups-${now().slice(0, 10)}.txt`), { caption: `${groups.length} unique groups recorded by IOAds.` });
    logAdmin(db, "group_directory_exported", undefined, { groups: groups.length });
  }

  async function campaigns(ctx: Context, requested = 0, rowId?: number): Promise<unknown> {
    const t = rowId ? tenant(rowId) : undefined;
    const where = t ? "WHERE c.tenantId=?" : "";
    const args = t ? [t.tenantId] : [];
    const total = n(db, `SELECT COUNT(*) AS n FROM campaigns c ${where}`, ...args);
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT c.id,c.tenantId,c.name,c.status,c.nextRunAt,c.senderAccountId FROM campaigns c ${where} ORDER BY CASE c.status WHEN 'scheduled' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,c.updatedAt DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, page * pageSize) as Campaign[];
    const buttons: Button[][] = rows.map((row) => [button(`${short(row.name, 30)} · ${row.status}`, `a:c:${row.id}`)]);
    const prefix = t ? `a:tc:${rowId}` : "a:campaigns";
    buttons.push([...(page ? [button("Previous", `${prefix}:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `${prefix}:${page + 1}`, undefined, "next")] : [])]);
    buttons.push([back(t ? `a:t:${rowId}` : "a:home", t ? "Back to tenant" : "Admin home")]);
    return render(ctx, `<h2>Campaigns</h2><p>${total} campaigns. Open one to inspect or pause/resume it.</p>`, buttons);
  }

  async function showCampaign(ctx: Context, id: number, confirm?: "pause" | "resume"): Promise<unknown> {
    const c = db.prepare("SELECT c.id,c.tenantId,c.name,c.status,c.nextRunAt,c.senderAccountId,t.rowid AS tenantRow FROM campaigns c JOIN tenants t ON t.tenantId=c.tenantId WHERE c.id=?")
      .get(id) as Campaign & { tenantRow: number } | undefined;
    if (!c) return campaigns(ctx);
    const targets = n(db, "SELECT COUNT(*) AS n FROM campaignTargets WHERE campaignId=? AND enabled=1", id);
    const pending = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE campaignId=? AND status IN ('pending','retry','claimed')", id);
    const failed = n(db, "SELECT COUNT(*) AS n FROM deliveries WHERE campaignId=? AND status='failed'", id);
    const action = c.status === "scheduled" ? "pause" : "resume";
    const prompt = confirm ? `<p><b>Confirm ${confirm}?</b> ${confirm === "pause" ? "Pending jobs will wait while the campaign is paused." : "The campaign can begin sending again."}</p>` : "";
    return render(ctx, `<h2>${e(c.name)}</h2><p>Status: ${e(c.status)}<br/>Next run: ${e(date(c.nextRunAt))}<br/>Enabled targets: ${targets}<br/>Queued: ${pending}<br/>Failed: ${failed}</p>${prompt}`, [
      [button(confirm ? `Confirm ${confirm}` : action === "pause" ? "Pause campaign" : "Resume campaign", confirm ? `a:cgo:${id}:${confirm}` : `a:cconfirm:${id}:${action}`, confirm === "pause" || action === "pause" ? "danger" : "success")],
      [button("Failures", `a:cf:${id}:0`, undefined, "warning"), button("Tenant", `a:t:${c.tenantRow}`)],
      [back("a:campaigns:0", "Back to campaigns")],
    ]);
  }

  async function failures(ctx: Context, requested = 0, rowId?: number, accountRow?: number, campaignId?: number): Promise<unknown> {
    const t = rowId ? tenant(rowId) : undefined;
    const a = accountRow ? db.prepare("SELECT tenantId,accountId FROM accounts WHERE rowid=?").get(accountRow) as { tenantId: string; accountId: string } | undefined : undefined;
    const where = `${t ? "AND d.tenantId=?" : ""} ${a ? "AND d.tenantId=? AND d.accountId=?" : ""} ${campaignId ? "AND d.campaignId=?" : ""} ${failureSearch ? "AND COALESCE(d.error,'') LIKE ?" : ""}`;
    const args: unknown[] = [...(t ? [t.tenantId] : []), ...(a ? [a.tenantId, a.accountId] : []), ...(campaignId ? [campaignId] : []), ...(failureSearch ? [`%${failureSearch}%`] : [])];
    const total = n(db, `SELECT COUNT(*) AS n FROM deliveries d WHERE d.status IN ('failed','retry') ${where}`, ...args);
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT d.id,d.status,d.error,c.name FROM deliveries d JOIN campaigns c ON c.id=d.campaignId WHERE d.status IN ('failed','retry') ${where} ORDER BY d.id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, page * pageSize) as Array<{ id: number; status: string; error: string | null; name: string }>;
    const buttons: Button[][] = rows.map((row) => [button(`${short(row.name, 24)} · ${row.status} · ${short(row.error, 17)}`, `a:f:${row.id}`)]);
    const prefix = t ? `a:tf:${rowId}` : a ? `a:af:${accountRow}` : campaignId ? `a:cf:${campaignId}` : "a:failures";
    buttons.push([...(page ? [button("Previous", `${prefix}:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `${prefix}:${page + 1}`, undefined, "next")] : [])]);
    if (!t && !a && !campaignId) buttons.push([button("Search error text", "a:search:failures", "primary"), button("Clear search", "a:clear:failures")]);
    buttons.push([back(t ? `a:t:${rowId}` : a ? `a:acc:${accountRow}` : campaignId ? `a:c:${campaignId}` : "a:home", t ? "Back to tenant" : a ? "Back to account" : campaignId ? "Back to campaign" : "Admin home")]);
    return render(ctx, `<h2>Delivery failures</h2><p>${total} failed or retrying deliveries${failureSearch ? ` · error contains: ${e(failureSearch)}` : ""}.</p>`, buttons);
  }

  async function showFailure(ctx: Context, id: number, confirm = false): Promise<unknown> {
    const d = db.prepare("SELECT d.id,d.tenantId,d.campaignId,d.status,d.attempts,d.error,d.nextAttemptAt,d.chatId,g.title,c.name,c.status AS campaignStatus FROM deliveries d JOIN campaigns c ON c.id=d.campaignId LEFT JOIN groups g ON g.tenantId=d.tenantId AND g.accountId=d.accountId AND g.chatId=d.chatId WHERE d.id=?")
      .get(id) as { id: number; tenantId: string; campaignId: number; status: string; attempts: number; error: string | null; nextAttemptAt: string | null; title: string | null; name: string; campaignStatus: string } | undefined;
    if (!d) return failures(ctx);
    return render(ctx, `<h2>${e(d.name)}</h2><p>Group: ${e(d.title || "Unknown group")}<br/>Status: ${e(d.status)} · attempts: ${d.attempts}<br/>Next retry: ${e(date(d.nextAttemptAt))}<br/>Error: ${e(short(d.error || "No error", 400))}</p>${confirm ? "<p>Retrying may duplicate a post if Telegram accepted it before the failure was recorded.</p>" : ""}`, [
      ...(d.status === "failed" && d.campaignStatus === "scheduled" ? [[button(confirm ? "Confirm retry" : "Retry failed delivery", confirm ? `a:retrygo:${id}` : `a:retry:${id}`, "danger")]] : []),
      [button("Campaign", `a:c:${d.campaignId}`), back("a:failures:0", "Back to failures")],
    ]);
  }

  async function audit(ctx: Context, requested = 0): Promise<unknown> {
    const total = n(db, "SELECT (SELECT COUNT(*) FROM adminActions)+(SELECT COUNT(*) FROM audit) AS n");
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT createdAt,action,subject,detail FROM (
      SELECT createdAt,action,subject,detail FROM adminActions
      UNION ALL SELECT createdAt,action,tenantId AS subject,detail FROM audit
      ) ORDER BY createdAt DESC LIMIT ? OFFSET ?`).all(pageSize, page * pageSize) as Array<{ createdAt: string; action: string; subject: string | null; detail: string | null }>;
    const lines = rows.map((row) => `<li><b>${e(row.action)}</b> · ${e(date(row.createdAt))}<br/>${e(short(row.subject || "Service", 55))}${row.detail ? ` · ${e(short(row.detail, 110))}` : ""}</li>`).join("");
    return render(ctx, `<h2>Audit</h2>${lines ? `<ul>${lines}</ul>` : "<p>No activity yet.</p>"}`, [
      [...(page ? [button("Previous", `a:audit:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `a:audit:${page + 1}`, undefined, "next")] : [])],
      nav(),
    ]);
  }

  async function broadcasts(ctx: Context, requested = 0): Promise<unknown> {
    const total = n(db, "SELECT COUNT(*) AS n FROM adminBroadcasts");
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare("SELECT id,status,audience,createdAt FROM adminBroadcasts ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(pageSize, page * pageSize) as Array<{ id: number; status: string; audience: number; createdAt: string }>;
    const buttons: Button[][] = [[button("New broadcast", "a:newbroadcast", "primary", "plus")], ...rows.map((row) => [button(`${date(row.createdAt)} · ${row.status}`, `a:b:${row.id}`)])];
    buttons.push([...(page ? [button("Previous", `a:broadcasts:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `a:broadcasts:${page + 1}`, undefined, "next")] : [])]);
    buttons.push(nav());
    return render(ctx, `<h2>Broadcasts</h2><p>Bot users receive a bot copy. Userbots post once per enabled group, even when several accounts share that group.</p>`, buttons);
  }

  async function showBroadcast(ctx: Context, id: number, confirmAudience?: Audience): Promise<unknown> {
    const b = db.prepare("SELECT id,audience,status,message,contentKind,archiveChatId,createdAt,startedAt,finishedAt FROM adminBroadcasts WHERE id=?")
      .get(id) as { id: number; audience: Audience; status: string; message: string | null; contentKind: string; archiveChatId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null } | undefined;
    if (!b) return broadcasts(ctx);
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END),0) AS sent,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,
      COALESCE(SUM(CASE WHEN status IN ('pending','retry','claimed') THEN 1 ELSE 0 END),0) AS remaining
      FROM adminBroadcastTargets WHERE broadcastId=?`).get(id) as { total: number; sent: number; failed: number; remaining: number };
    const rows: Button[][] = [];
    let audienceText = "";
    if (b.status === "draft") {
      const all = broadcastAudienceCounts(db, 3), free = broadcastAudienceCounts(db, 2);
      audienceText = `<p>1. Bot users: ${all.botUsers}<br/>2. Bot users + Free userbot groups: ${all.botUsers} + ${free.groups}<br/>3. Bot users + all userbot groups: ${all.botUsers} + ${all.groups}</p>`;
      if (confirmAudience) {
        const preview = broadcastAudienceCounts(db, confirmAudience);
        audienceText += `<p><b>Confirm audience ${confirmAudience}:</b> ${preview.botUsers} bot users, ${preview.groups} groups. The recipient list is saved when you confirm.</p>`;
        rows.push([button("Start broadcast", `a:sendgo:${id}:${confirmAudience}`, "danger", "megaphone")]);
      } else {
        rows.push([button("1 · Bot users", `a:sendconfirm:${id}:1`)]);
        if (b.contentKind === "text" || b.archiveChatId) {
          rows.push([button("2 · Bot + Free userbots", `a:sendconfirm:${id}:2`)]);
          rows.push([button("3 · Bot + all userbots", `a:sendconfirm:${id}:3`)]);
        }
      }
      rows.push([button("Discard draft", `a:bcancel:${id}`, "danger")]);
    } else if (b.status === "running" || b.status === "paused") {
      rows.push([button(b.status === "running" ? "Pause broadcast" : "Resume broadcast", `a:bstatus:${id}:${b.status === "running" ? "pause" : "resume"}`, b.status === "running" ? "danger" : "success")]);
      rows.push([button("Cancel remaining", `a:bcancelconfirm:${id}`, "danger")]);
    }
    if (counts.failed) rows.push([button(`Failures · ${counts.failed}`, `a:bfails:${id}:0`, undefined, "warning")]);
    rows.push([button("Refresh", `a:b:${id}`, "link", "refresh"), back("a:broadcasts:0", "Back to broadcasts")]);
    return render(ctx, `<h2>Broadcast</h2><p>${e(b.status)} · ${e(b.contentKind)}<br/>${e(short(b.message || "Media or rich post", 190))}<br/>Created: ${e(date(b.createdAt))}${b.startedAt ? `<br/>Started: ${e(date(b.startedAt))}` : ""}</p><table compact><tr><td>Destinations</td><td>${counts.total}</td></tr><tr><td>Sent</td><td>${counts.sent}</td></tr><tr><td>Remaining</td><td>${counts.remaining}</td></tr><tr><td>Failed</td><td>${counts.failed}</td></tr></table>${audienceText}`, rows);
  }

  async function broadcastFailures(ctx: Context, id: number, requested = 0): Promise<unknown> {
    const total = n(db, "SELECT COUNT(*) AS n FROM adminBroadcastTargets WHERE broadcastId=? AND status='failed'", id);
    const page = Math.min(Math.max(0, requested), Math.max(0, Math.ceil(total / pageSize) - 1));
    const rows = db.prepare(`SELECT q.kind,q.error,COALESCE(g.title,u.displayName,u.username,'Unknown destination') AS destination
      FROM adminBroadcastTargets q LEFT JOIN groups g ON g.tenantId=q.tenantId AND g.accountId=q.accountId AND g.chatId=q.chatId
      LEFT JOIN localUsers u ON q.kind='bot' AND CAST(u.telegramId AS TEXT)=q.chatId
      WHERE q.broadcastId=? AND q.status='failed' ORDER BY q.id DESC LIMIT ? OFFSET ?`)
      .all(id, pageSize, page * pageSize) as Array<{ kind: string; error: string | null; destination: string }>;
    const lines = rows.map((row) => `<li><b>${e(short(row.destination, 45))}</b> · ${e(short(row.error || "Unknown error", 150))}</li>`).join("");
    return render(ctx, `<h2>Broadcast failures</h2><p>${total} failed destinations.</p>${lines ? `<ul>${lines}</ul>` : ""}`, [
      [...(page ? [button("Previous", `a:bfails:${id}:${page - 1}`, undefined, "prev")] : []), ...(page < Math.ceil(total / pageSize) - 1 ? [button("Next", `a:bfails:${id}:${page + 1}`, undefined, "next")] : [])],
      [back(`a:b:${id}`, "Back to broadcast")],
    ]);
  }

  async function handleCallback(ctx: Context, data: string): Promise<unknown> {
    await ctx.answerCallbackQuery();
    let m: RegExpMatchArray | null;
    if (data === "a:home") return dashboard(ctx);
    if ((m = data.match(/^a:users:(\d+)$/))) return users(ctx, Number(m[1]));
    if ((m = data.match(/^a:u:(\d+)$/))) return showUser(ctx, Number(m[1]));
    if ((m = data.match(/^a:tenants:(\d+)$/))) return tenants(ctx, Number(m[1]));
    if ((m = data.match(/^a:t:(\d+)$/))) return showTenant(ctx, Number(m[1]));
    if ((m = data.match(/^a:accounts:(\d+)$/))) return accounts(ctx, Number(m[1]));
    if ((m = data.match(/^a:ta:(\d+):(\d+)$/))) return accounts(ctx, Number(m[2]), Number(m[1]));
    if ((m = data.match(/^a:acc:(\d+)$/))) return showAccount(ctx, Number(m[1]));
    if ((m = data.match(/^a:tg:(\d+):(\d+)$/))) return groups(ctx, Number(m[2]), Number(m[1]));
    if ((m = data.match(/^a:ag:(\d+):(\d+)$/))) return groups(ctx, Number(m[2]), undefined, Number(m[1]));
    if ((m = data.match(/^a:g:(\d+)$/))) return showGroup(ctx, Number(m[1]));
    if ((m = data.match(/^a:directory:(\d+)$/))) return directory(ctx, Number(m[1]));
    if ((m = data.match(/^a:dg:(-?\d+):(\d+)$/))) return directoryGroup(ctx, m[1], Number(m[2]));
    if (data === "a:exportgroups") return exportGroups(ctx);
    if (data === "a:refreshgroups") { await refreshMissingGroupLinks(); return directory(ctx); }
    if ((m = data.match(/^a:campaigns:(\d+)$/))) return campaigns(ctx, Number(m[1]));
    if ((m = data.match(/^a:tc:(\d+):(\d+)$/))) return campaigns(ctx, Number(m[2]), Number(m[1]));
    if ((m = data.match(/^a:c:(\d+)$/))) return showCampaign(ctx, Number(m[1]));
    if ((m = data.match(/^a:cconfirm:(\d+):(pause|resume)$/))) return showCampaign(ctx, Number(m[1]), m[2] as "pause" | "resume");
    if ((m = data.match(/^a:cgo:(\d+):(pause|resume)$/))) {
      const c = db.prepare("SELECT tenantId,status FROM campaigns WHERE id=?").get(Number(m[1])) as { tenantId: string; status: string } | undefined;
      if (!c || (m[2] === "pause" && c.status !== "scheduled") || (m[2] === "resume" && c.status === "scheduled")) throw new Error("campaign state changed; reopen it");
      setCampaignStatus(db, c.tenantId, Number(m[1]), m[2] === "pause" ? "paused" : "scheduled");
      logAdmin(db, `campaign_${m[2]}`, c.tenantId, { campaignId: Number(m[1]) });
      return showCampaign(ctx, Number(m[1]));
    }
    if ((m = data.match(/^a:failures:(\d+)$/))) return failures(ctx, Number(m[1]));
    if ((m = data.match(/^a:tf:(\d+):(\d+)$/))) return failures(ctx, Number(m[2]), Number(m[1]));
    if ((m = data.match(/^a:af:(\d+):(\d+)$/))) return failures(ctx, Number(m[2]), undefined, Number(m[1]));
    if ((m = data.match(/^a:cf:(\d+):(\d+)$/))) return failures(ctx, Number(m[2]), undefined, undefined, Number(m[1]));
    if ((m = data.match(/^a:f:(\d+)$/))) return showFailure(ctx, Number(m[1]));
    if ((m = data.match(/^a:retry:(\d+)$/))) return showFailure(ctx, Number(m[1]), true);
    if ((m = data.match(/^a:retrygo:(\d+)$/))) {
      const changed = db.prepare(`UPDATE deliveries SET status='retry',attempts=0,nextAttemptAt=?,error=NULL WHERE id=? AND status='failed'
        AND EXISTS(SELECT 1 FROM campaigns c WHERE c.id=deliveries.campaignId AND c.status='scheduled')`).run(now(), Number(m[1]));
      if (!changed.changes) throw new Error("delivery is no longer retryable");
      logAdmin(db, "delivery_retried", String(m[1]));
      return showFailure(ctx, Number(m[1]));
    }
    if ((m = data.match(/^a:audit:(\d+)$/))) return audit(ctx, Number(m[1]));
    if ((m = data.match(/^a:broadcasts:(\d+)$/))) return broadcasts(ctx, Number(m[1]));
    if ((m = data.match(/^a:b:(\d+)$/))) return showBroadcast(ctx, Number(m[1]));
    if ((m = data.match(/^a:bfails:(\d+):(\d+)$/))) return broadcastFailures(ctx, Number(m[1]), Number(m[2]));
    if ((m = data.match(/^a:sendconfirm:(\d+):([123])$/))) return showBroadcast(ctx, Number(m[1]), Number(m[2]) as Audience);
    if ((m = data.match(/^a:sendgo:(\d+):([123])$/))) {
      startAdminBroadcast(db, Number(m[1]), Number(m[2]) as Audience);
      return showBroadcast(ctx, Number(m[1]));
    }
    if ((m = data.match(/^a:bstatus:(\d+):(pause|resume)$/))) {
      setAdminBroadcastStatus(db, Number(m[1]), m[2] as "pause" | "resume");
      return showBroadcast(ctx, Number(m[1]));
    }
    if ((m = data.match(/^a:bcancelconfirm:(\d+)$/))) return render(ctx, "<h2>Cancel broadcast?</h2><p>Unsent destinations will be skipped. A message already being sent may still arrive.</p>", [[button("Cancel remaining", `a:bcancel:${m[1]}`, "danger")], [back(`a:b:${m[1]}`, "Back to broadcast")]]);
    if ((m = data.match(/^a:bcancel:(\d+)$/))) { setAdminBroadcastStatus(db, Number(m[1]), "cancel"); return showBroadcast(ctx, Number(m[1])); }
    if (data === "a:newbroadcast") {
      setFlow("broadcast_post");
      return render(ctx, "<h2>New broadcast</h2><p>Send or forward one post here. Text, formatting, supported media, and URL or copy buttons are kept. Albums are not supported. Afterward, choose the audience and confirm the destination count.</p>", [[button("Cancel", "a:broadcasts:0", "link")]]);
    }
    if ((m = data.match(/^a:search:(users|tenants|failures)$/))) {
      setFlow(`search_${m[1]}`);
      return render(ctx, `<h2>Search ${e(m[1])}</h2><p>${m[1] === "failures" ? "Send part of an error message." : "Send a name or username. Use the buttons in the results to select a person or tenant. You can also forward a bot user's message to select them."}</p>`, [[back(m[1] === "users" ? "a:users:0" : m[1] === "tenants" ? "a:tenants:0" : "a:failures:0", "Cancel search")]]);
    }
    if ((m = data.match(/^a:clear:(users|tenants|failures)$/))) {
      setFlow(null);
      if (m[1] === "users") { userSearch = ""; return users(ctx); }
      if (m[1] === "failures") { failureSearch = ""; return failures(ctx); }
      tenantSearch = ""; return tenants(ctx);
    }
    if ((m = data.match(/^a:grant:(\d+):(pro|business)$/))) {
      return render(ctx, `<h2>Grant ${e(m[2])}</h2><p>Choose how long to extend this person's paid access.</p>`, [
        [button("30 days", `a:grantconfirm:${m[1]}:${m[2]}:30`), button("90 days", `a:grantconfirm:${m[1]}:${m[2]}:90`)],
        [button("365 days", `a:grantconfirm:${m[1]}:${m[2]}:365`)],
        [back(`a:u:${m[1]}`, "Back to user")],
      ]);
    }
    if ((m = data.match(/^a:grantconfirm:(\d+):(pro|business):(30|90|365)$/))) {
      const user = db.prepare("SELECT displayName,username,paidUntil FROM localUsers WHERE telegramId=?").get(Number(m[1])) as { displayName: string | null; username: string | null; paidUntil: string | null } | undefined;
      if (!user) throw new Error("user not found");
      return render(ctx, `<h2>Confirm premium grant</h2><p>${e(user.displayName || (user.username ? `@${user.username}` : "Selected bot user"))}<br/>Plan: ${e(m[2])}<br/>Extend by ${m[3]} days from the current expiry or today, whichever is later.</p>`, [[button("Confirm grant", `a:grantgo:${m[1]}:${m[2]}:${m[3]}`, "success", "check")], [back(`a:u:${m[1]}`, "Back to user")]]);
    }
    if ((m = data.match(/^a:grantgo:(\d+):(pro|business):(30|90|365)$/))) {
      const until = grantStandalonePlan(db, Number(m[1]), m[2] as "pro" | "business", Number(m[3]));
      void bot.api.sendMessage(Number(m[1]), `Your IOAds ${m[2]} plan is active until ${date(until)}.`).catch(() => undefined);
      return showUser(ctx, Number(m[1]));
    }
    if ((m = data.match(/^a:revoke:(\d+)$/))) return render(ctx, "<h2>Revoke premium?</h2><p>This returns the selected user to Free now. Excess accounts and campaigns will be paused by the plan limits.</p>", [[button("Confirm revoke", `a:revokego:${m[1]}`, "danger")], [back(`a:u:${m[1]}`, "Back to user")]]);
    if ((m = data.match(/^a:revokego:(\d+)$/))) {
      grantStandalonePlan(db, Number(m[1]), "free");
      void bot.api.sendMessage(Number(m[1]), "Your IOAds plan is now Free.").catch(() => undefined);
      return showUser(ctx, Number(m[1]));
    }
    if ((m = data.match(/^a:blockconfirm:(\d+):([01])$/))) {
      const blocked = m[2] === "1";
      const user = db.prepare("SELECT displayName,username,blocked FROM localUsers WHERE telegramId=?").get(Number(m[1])) as { displayName: string | null; username: string | null; blocked: number } | undefined;
      if (!user || Boolean(user.blocked) === blocked) throw new Error("user state changed; reopen their profile");
      return render(ctx, `<h2>${blocked ? "Block" : "Unblock"} user?</h2><p>${e(user.displayName || (user.username ? `@${user.username}` : "Selected bot user"))}</p><p>${blocked ? "Bot commands and inline results will stop. Every connected userbot will stop sending, and queued posts will be skipped. Saved sessions and campaign settings will be kept." : "Bot access will return. Saved userbots will resume only within the user's current plan limits; skipped posts will not be resent."}</p>`, [
        [button(blocked ? "Confirm block" : "Confirm unblock", `a:blockgo:${m[1]}:${m[2]}`, blocked ? "danger" : "success")],
        [back(`a:u:${m[1]}`, "Back to user")],
      ]);
    }
    if ((m = data.match(/^a:blockgo:(\d+):([01])$/))) {
      const blocked = m[2] === "1";
      await setUserBlocked(db, Number(m[1]), blocked);
      if (blocked) onUserBlocked?.(Number(m[1]));
      void bot.api.sendMessage(Number(m[1]), blocked ? "Your IOAds access has been blocked by the administrator." : "Your IOAds access has been restored.").catch(() => undefined);
      return showUser(ctx, Number(m[1]));
    }
    throw new Error("admin action not found");
  }

  async function handleAdminPost(ctx: Context): Promise<unknown> {
    const msg = ctx.message;
    if (!msg || !ctx.chat) throw new Error("send a post");
    if (msg.media_group_id) throw new Error("Send one post at a time; Telegram albums arrive as separate updates");
    if (msg.reply_markup?.inline_keyboard.some((row) => row.some((item) => !("url" in item || "copy_text" in item))))
      throw new Error("Buttons tied to another bot cannot be broadcast. Use URL or copy buttons.");
    if (msg.rich_message) reusableRichMessage(msg.rich_message);
    const message = msg.text ?? msg.caption ?? null;
    if (!message && !msg.rich_message && !msg.photo && !msg.video && !msg.document && !msg.animation && !msg.audio && !msg.voice && !msg.sticker)
      throw new Error("Send text, a rich post, or supported media");
    const contentKind = msg.text && !msg.rich_message && !msg.reply_markup && !msg.link_preview_options ? "text" : "copy";
    const archived = config.archiveChat ? await ctx.api.copyMessage(config.archiveChat, ctx.chat.id, msg.message_id) : null;
    const id = createAdminBroadcast(db, {
      sourceChatId: String(ctx.chat.id), sourceMessageId: msg.message_id,
      archiveChatId: archived ? config.archiveChat : null, archiveMessageId: archived?.message_id ?? null,
      message, entities: JSON.stringify(msg.entities ?? msg.caption_entities ?? []), contentKind,
    });
    setFlow(null);
    return showBroadcast(ctx, id);
  }

  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    const isAdminAction = data?.startsWith("a:") || ctx.message?.text?.match(/^\/(?:admin|groups|cancel)(?:@\w+)?(?:\s|$)/i);
    if (isAdminAction && !requireAdmin(ctx)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Admin controls are private.", show_alert: true });
      else if (ctx.chat?.type === "private") await ctx.reply("Admin controls are unavailable.");
      return;
    }
    if (!requireAdmin(ctx)) return next();
    try {
      if (ctx.message?.text?.match(/^\/admin(?:@\w+)?(?:\s|$)/i)) return void await dashboard(ctx);
      if (ctx.message?.text?.match(/^\/groups(?:@\w+)?(?:\s|$)/i)) {
        setFlow(null);
        await exportGroups(ctx);
        return;
      }
      if (ctx.message?.text?.match(/^\/cancel(?:@\w+)?(?:\s|$)/i) && flow()) { setFlow(null); return void await dashboard(ctx); }
      if (data?.startsWith("a:")) { setFlow(null); return void await handleCallback(ctx, data); }
      const current = flow();
      if (current && ctx.message) {
        if (current.action === "broadcast_post") return void await handleAdminPost(ctx);
        if (current.action === "search_users" && ctx.message.forward_origin?.type === "user") {
          const forwardedId = ctx.message.forward_origin.sender_user.id;
          if (!db.prepare("SELECT 1 FROM localUsers WHERE telegramId=?").get(forwardedId)) throw new Error("That person has not started the Ads bot yet.");
          setFlow(null);
          return void await showUser(ctx, forwardedId);
        }
        if (ctx.message.text && current.action === "search_users") { userSearch = ctx.message.text.trim().slice(0, 80); setFlow(null); return void await users(ctx); }
        if (ctx.message.text && current.action === "search_tenants") { tenantSearch = ctx.message.text.trim().slice(0, 80); setFlow(null); return void await tenants(ctx); }
        if (ctx.message.text && current.action === "search_failures") { failureSearch = ctx.message.text.trim().slice(0, 80); setFlow(null); return void await failures(ctx); }
        return void await render(ctx, "Send text for this search, or use /cancel.", [[button("Cancel", "a:home")]]);
      }
      return next();
    } catch (error) {
      const message = e(short(error instanceof Error ? error.message : String(error), 350));
      await render(ctx, `<h2>Admin action failed</h2><p>${message}</p>`, [[button("Admin home", "a:home", "primary")]]);
    }
  });

  void bot.api.setMyCommands([
    { command: "admin", description: "Open IOAds admin" },
    { command: "groups", description: "Export all group links as a text file" },
    { command: "menu", description: "Public menu" },
    { command: "cancel", description: "Cancel admin input" },
  ], { scope: { type: "chat", chat_id: config.adminTelegramId } }).catch((error) => console.error(`ads admin commands failed: ${String(error)}`));

  let pumping = false;
  const notifyFinished = async () => {
    const rows = db.prepare("SELECT id FROM adminBroadcasts WHERE status='completed' AND notifiedAt IS NULL ORDER BY id LIMIT 10").all() as Array<{ id: number }>;
    for (const row of rows) {
      const result = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END),0) AS sent,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed
        FROM adminBroadcastTargets WHERE broadcastId=?`).get(row.id) as { total: number; sent: number; failed: number };
      await bot.api.raw.sendRichMessage({ chat_id: config.adminTelegramId, rich_message: { html: richHtml(`<h2>Broadcast finished</h2><p>${result.sent} sent · ${result.failed} failed · ${result.total} destinations</p>`, [[button("Open broadcast", `a:b:${row.id}`, "primary")]], true) } });
      db.prepare("UPDATE adminBroadcasts SET notifiedAt=? WHERE id=? AND notifiedAt IS NULL").run(now(), row.id);
    }
  };
  const tick = () => {
    if (pumping) return;
    pumping = true;
    void runAdminBroadcastOnce(db, (chatId, sourceChatId, sourceMessageId) => bot.api.copyMessage(chatId, sourceChatId, sourceMessageId), undefined, 8)
      .then(notifyFinished)
      .catch((error) => console.error(`ads admin broadcast pump failed: ${String(error)}`))
      .finally(() => { pumping = false; });
  };
  tick();
  const timer = setInterval(tick, 1_000);
  timer.unref();
  process.once("SIGTERM", () => clearInterval(timer));
  process.once("SIGINT", () => clearInterval(timer));
}
