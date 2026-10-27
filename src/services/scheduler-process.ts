import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { adapterFor } from "./account.js";

type Request = { id: number; kind: "account"; tenantId?: string; accountId?: string;
  method?: "sendMessage" | "copyMessage" | "sendInline"; args: unknown[] };

let schedulerStatus = { running: false, failures: 0 };
export const schedulerProcessStatus = (): { running: boolean; failures: number } => ({ ...schedulerStatus });

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
    schedulerStatus = { running: true, failures };
    next.on("message", (request: Request) => {
      void (async () => {
        try {
          let value: unknown;
          if (request.kind !== "account" || !request.tenantId || !request.accountId || !request.method) throw new Error("invalid scheduler request");
          const allowed = db.prepare(`SELECT 1 FROM accounts a JOIN tenants t ON t.tenantId=a.tenantId
            LEFT JOIN localUsers u ON u.tenantId=a.tenantId WHERE a.tenantId=? AND a.accountId=?
            AND a.status='active' AND a.session IS NOT NULL AND t.state='active' AND t.runtime='service'
            AND COALESCE(t.suspendReason,'')!='blocked' AND (u.blocked IS NULL OR u.blocked=0)`)
            .get(request.tenantId, request.accountId);
          if (!allowed) throw new Error("sender account is unavailable");
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
      schedulerStatus = { running: false, failures };
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
      console.error(`ads scheduler process exited (${code ?? signal}); restarting in ${delay}ms`);
      setTimeout(start, delay).unref();
    });
    next.on("error", (error) => console.error(`ads scheduler process error: ${String(error)}`));
    setTimeout(() => { if (child === next) { failures = 0; schedulerStatus = { running: true, failures }; } }, 60_000).unref();
  };
  start();
  const stop = () => { stopped = true; schedulerStatus = { running: false, failures }; child?.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
