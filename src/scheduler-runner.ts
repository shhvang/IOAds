import { openDb } from "./db.js";
import { config } from "./config.js";
import { startDeliveryPump } from "./services/scheduler.js";
import type { TelegramAdapter } from "./telegram.js";

type Reply = { id: number; ok: boolean; value?: unknown; error?: string };
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
let sequence = 0;
let stopped = false;
const db = openDb(`${config.dataDir}/ads.db`);

function call(kind: "account", args: unknown[], tenantId?: string, accountId?: string, method?: string): Promise<any> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("sender request timeout"));
    }, 90_000);
    pending.set(id, { resolve, reject, timer });
    process.send?.({ id, kind, tenantId, accountId, method, args });
  });
}

process.on("message", (reply: Reply) => {
  const request = pending.get(reply.id);
  if (!request) return;
  pending.delete(reply.id);
  clearTimeout(request.timer);
  if (reply.ok) request.resolve(reply.value);
  else request.reject(new Error(reply.error ?? "sender request failed"));
});

function account(tenantId: string, accountId: string): TelegramAdapter {
  const invoke = (method: string, args: unknown[]) => call("account", args, tenantId, accountId, method);
  return {
    sendCode: (phone) => invoke("sendCode", [phone]),
    signIn: (phone, hash, code, password) => invoke("signIn", [phone, hash, code, password]),
    resumeSession: () => invoke("resumeSession", []),
    dialogs: () => invoke("dialogs", []),
    canPost: (chatId) => invoke("canPost", [chatId]),
    sendMessage: (chatId, message, entities) => invoke("sendMessage", [chatId, message, entities]),
    copyMessage: (chatId, sourceChatId, messageId, requiresPremium) => invoke("copyMessage", [chatId, sourceChatId, messageId, requiresPremium]),
    sendInline: (chatId, query) => invoke("sendInline", [chatId, query]),
    logout: () => invoke("logout", []),
    close: () => invoke("close", []),
  };
}

const stopDeliveries = startDeliveryPump(db, account, config.schedulerIntervalMs);
process.on("disconnect", () => { stopped = true; stopDeliveries(); db.close(); process.exit(0); });
process.once("SIGTERM", () => { stopped = true; stopDeliveries(); setTimeout(() => process.exit(0), 5_000).unref(); });
