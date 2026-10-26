import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { adapterFor } from "./account.js";

type Request = { id: number; kind: "account"; tenantId?: string; accountId?: string;
  method?: "sendMessage" | "copyMessage" | "sendInline"; args: unknown[] };

export function startSchedulerProcess(db: Database.Database): void {
  let child: ChildProcess | null = null;
  let failures = 0;
  let stopped = false;
  const start = () => {
    if (stopped) return;
    const compiled = fileURLToPath(new URL("../scheduler-runner.js", import.meta.url));
    const source = fileURLToPath(new URL("../scheduler-runner.ts", import.meta.url));
    const built = existsSync(compiled);
    const next = fork(built ? compiled : source, [], {
      execArgv: built ? [] : ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child = next;
    next.on("message", (request: Request) => {
      void (async () => {
        try {
          let value: unknown;
          if (request.kind !== "account" || !request.tenantId || !request.accountId || !request.method) throw new Error("invalid scheduler request");
          const adapter = adapterFor(db, request.tenantId, request.accountId);
          value = await (adapter[request.method] as (...args: unknown[]) => Promise<unknown>)(...request.args);
          if (next.connected) next.send({ id: request.id, ok: true, value });
        } catch (error) {
          if (next.connected) next.send({ id: request.id, ok: false, error: String(error) });
        }
      })();
    });
    next.on("exit", (code, signal) => {
      if (child !== next || stopped) return;
      child = null;
      failures += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
      console.error(`ads scheduler process exited (${code ?? signal}); restarting in ${delay}ms`);
      setTimeout(start, delay).unref();
    });
    next.on("error", (error) => console.error(`ads scheduler process error: ${String(error)}`));
    setTimeout(() => { if (child === next) failures = 0; }, 60_000).unref();
  };
  start();
  const stop = () => { stopped = true; child?.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
