import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type { TelegramAdapter, TelegramDialog } from "../telegram.js";

type Method = keyof TelegramAdapter;
type Reply = { id: number; ok: boolean; value?: unknown; error?: string };
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Shard = { child: ChildProcess | null; pending: Map<number, Pending>; failures: number; restart: NodeJS.Timeout | null };

let shards: Shard[] | null = null;
let sequence = 0;
let stopping = false;

function startShard(index: number): void {
  const shard = shards![index]!;
  const compiled = fileURLToPath(new URL("../worker.js", import.meta.url));
  const source = fileURLToPath(new URL("../worker.ts", import.meta.url));
  const built = existsSync(compiled);
  const child = fork(built ? compiled : source, [], {
    execArgv: built ? [] : ["--import", "tsx"],
    env: { ...process.env, ADS_WORKER_CHILD: "1" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  shard.child = child;
  child.on("message", (message: Reply) => {
    const pending = shard.pending.get(message.id);
    if (!pending) return;
    shard.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error ?? "sender worker failed"));
  });
  child.on("exit", (code, signal) => {
    if (shard.child !== child) return;
    shard.child = null;
    for (const pending of shard.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("sender worker exited")); }
    shard.pending.clear();
    if (stopping) return;
    shard.failures += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(shard.failures - 1, 5));
    console.error(`ads sender shard ${index} exited (${code ?? signal}); restarting in ${delay}ms`);
    shard.restart = setTimeout(() => { shard.restart = null; startShard(index); }, delay);
  });
  child.on("error", (error) => console.error(`ads sender shard ${index} error: ${String(error)}`));
  setTimeout(() => { if (shard.child === child) shard.failures = 0; }, 60_000).unref();
}

export function startWorkerPool(): void {
  if (shards) return;
  shards = Array.from({ length: config.workerCount }, () => ({ child: null, pending: new Map(), failures: 0, restart: null }));
  shards.forEach((_shard, index) => startShard(index));
  process.once("SIGTERM", stopWorkerPool);
  process.once("SIGINT", stopWorkerPool);
}

export function stopWorkerPool(): void {
  stopping = true;
  for (const shard of shards ?? []) {
    if (shard.restart) clearTimeout(shard.restart);
    shard.child?.kill("SIGTERM");
  }
}

export function workerPoolStatus(): Array<{ index: number; running: boolean; pending: number; failures: number; restarting: boolean }> {
  return (shards ?? []).map((shard, index) => ({ index, running: Boolean(shard.child?.connected), pending: shard.pending.size, failures: shard.failures, restarting: Boolean(shard.restart) }));
}

function call(accountId: string, method: Method, args: unknown[]): Promise<any> {
  if (!shards) throw new Error("sender workers are unavailable");
  const digest = createHash("sha256").update(accountId).digest();
  const shard = shards[digest.readUInt32BE(0) % shards.length]!;
  if (!shard.child?.connected) throw new Error("sender worker is unavailable");
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      shard.pending.delete(id);
      reject(new Error("sender worker timeout"));
      if (method !== "close") shard.child?.kill("SIGKILL");
    }, method === "close" ? 15_000 : 75_000);
    shard.pending.set(id, { resolve, reject, timer });
    shard.child!.send({ id, accountId, method, args }, (error) => {
      if (!error) return;
      shard.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function remoteAdapterFor(accountId: string): TelegramAdapter | null {
  if (!shards) return null;
  return {
    sendCode: (phone: string) => call(accountId, "sendCode", [phone]),
    signIn: (phone: string, hash: string, code: string, password?: string) => call(accountId, "signIn", [phone, hash, code, password]),
    resumeSession: () => call(accountId, "resumeSession", []),
    profile: () => call(accountId, "profile", []),
    dialogs: (): Promise<TelegramDialog[]> => call(accountId, "dialogs", []),
    canPost: (chatId: string) => call(accountId, "canPost", [chatId]),
    sendMessage: (chatId: string, message: string, entities?: Array<Record<string, unknown>>) => call(accountId, "sendMessage", [chatId, message, entities]),
    copyMessage: (chatId: string, sourceChatId: string, messageId: number, requiresPremium?: boolean) => call(accountId, "copyMessage", [chatId, sourceChatId, messageId, requiresPremium]),
    sendInline: (chatId: string, query: string) => call(accountId, "sendInline", [chatId, query]),
    logout: () => call(accountId, "logout", []),
    close: () => call(accountId, "close", []),
  };
}
