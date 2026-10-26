import { config } from "./config.js";
import { createTelegramAdapter, type TelegramAdapter } from "./telegram.js";

type Request = { id: number; accountId: string; method: keyof TelegramAdapter; args: unknown[] };
type Entry = { adapter: TelegramAdapter; active: number; lastUsed: number; sendTail: Promise<unknown> };
const entries = new Map<string, Entry>();

function entryFor(accountId: string): Entry {
  let entry = entries.get(accountId);
  if (!entry) {
    entry = { adapter: createTelegramAdapter(accountId), active: 0, lastUsed: Date.now(), sendTail: Promise.resolve() };
    entries.set(accountId, entry);
  }
  entry.lastUsed = Date.now();
  return entry;
}

async function handle(request: Request): Promise<void> {
  let entry: Entry | undefined;
  try {
    entry = entryFor(request.accountId);
    entry.active += 1;
    const current = entry;
    const invoke = () => (current.adapter[request.method] as (...args: unknown[]) => Promise<unknown>)(...request.args);
    const isSend = request.method === "sendMessage" || request.method === "copyMessage" || request.method === "sendInline";
    const value = isSend ? await (current.sendTail = current.sendTail.then(invoke, invoke)) : await invoke();
    if (request.method === "logout" || request.method === "close") entries.delete(request.accountId);
    process.send?.({ id: request.id, ok: true, value });
  } catch (error) {
    process.send?.({ id: request.id, ok: false, error: String(error) });
  } finally {
    if (entry) { entry.active -= 1; entry.lastUsed = Date.now(); }
  }
}

process.on("message", (message: Request) => { void handle(message); });
process.on("disconnect", () => {
  for (const entry of entries.values()) void entry.adapter.close().catch(() => undefined);
  setTimeout(() => process.exit(0), 2_000).unref();
});
setInterval(() => {
  for (const [accountId, entry] of entries) {
    if (entry.active || Date.now() - entry.lastUsed < config.workerIdleMs) continue;
    entries.delete(accountId);
    void entry.adapter.close().catch(() => undefined);
  }
}, 60_000).unref();

process.once("SIGTERM", () => {
  for (const entry of entries.values()) void entry.adapter.close().catch(() => undefined);
  setTimeout(() => process.exit(0), 5_000).unref();
});
