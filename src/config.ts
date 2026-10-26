import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.DATA_DIR ?? "./data",
  ownerAuthSecret: process.env.ADS_OWNER_AUTH_SECRET ?? "",
  ownerAuthFallback: process.env.ADS_OWNER_AUTH_FALLBACK === "true",
  schedulerIntervalMs: Number(process.env.ADS_SCHEDULER_INTERVAL_MS ?? 1_000),
  deliveryConcurrency: Number(process.env.ADS_DELIVERY_CONCURRENCY ?? 64),
  workerCount: Number(process.env.ADS_WORKER_COUNT ?? 4),
  workerIdleMs: Number(process.env.ADS_WORKER_IDLE_MS ?? 300_000),
  telegramApiId: Number(process.env.TELEGRAM_API_ID ?? 0),
  telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
  sessionEncryptionKey: process.env.SESSION_ENCRYPTION_KEY ?? "",
  entryUrl: process.env.ADS_ENTRY_URL ?? null,
  botToken: process.env.BOT_TOKEN ?? "",
  telegramApiRoot: process.env.TELEGRAM_API_ROOT ?? "https://api.telegram.org",
  botOwnerId: Number(process.env.BOT_OWNER_ID ?? 0),
  botUsername: process.env.ADS_BOT_USERNAME ?? "",
  forceJoinChat: process.env.ADS_FORCE_JOIN_CHAT ?? "@iobuysell",
  archiveChat: process.env.ADS_ARCHIVE_CHAT ?? "",
  paymentBinancePayId: process.env.BINANCE_PAY_ID ?? "",
  paymentBinanceApiKey: process.env.BINANCE_API_KEY ?? "",
  paymentBinanceApiSecret: process.env.BINANCE_API_SECRET ?? "",
  paymentBinanceBaseUrl: process.env.BINANCE_BASE_URL ?? "https://api.binance.com",
  paymentNoderealKey: process.env.NODEREAL_API_KEY ?? "",
  paymentTrongridKey: process.env.TRONGRID_API_KEY ?? "",
  paymentBep20Address: process.env.BEP20_ADDRESS ?? "",
  paymentTrc20Address: process.env.TRC20_ADDRESS ?? "",
  rental: process.env.RENTAL_HUB_URL && process.env.RENTAL_SECRET
    ? { hubUrl: process.env.RENTAL_HUB_URL, secrets: process.env.RENTAL_SECRET.split(",").map((value) => value.trim()).filter(Boolean) }
    : null,
};

export function validateConfig(): void {
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("PORT must be a valid port");
  if (!Number.isSafeInteger(config.schedulerIntervalMs) || config.schedulerIntervalMs < 1000) throw new Error("ADS_SCHEDULER_INTERVAL_MS must be at least 1000");
  if (!Number.isSafeInteger(config.deliveryConcurrency) || config.deliveryConcurrency < 1 || config.deliveryConcurrency > 512) throw new Error("ADS_DELIVERY_CONCURRENCY must be 1-512");
  if (!Number.isSafeInteger(config.workerCount) || config.workerCount < 1 || config.workerCount > 64) throw new Error("ADS_WORKER_COUNT must be 1-64");
  if (!Number.isSafeInteger(config.workerIdleMs) || config.workerIdleMs < 60_000) throw new Error("ADS_WORKER_IDLE_MS must be at least 60000");
  if (config.botToken && (!config.botOwnerId || !config.telegramApiId || !config.telegramApiHash || !config.sessionEncryptionKey)) throw new Error("BOT_OWNER_ID, TELEGRAM_API_ID, TELEGRAM_API_HASH, and SESSION_ENCRYPTION_KEY are required with BOT_TOKEN");
  if (config.botToken && !config.archiveChat) throw new Error("ADS_ARCHIVE_CHAT is required with BOT_TOKEN");
  const hub = process.env.RENTAL_HUB_URL;
  const secret = process.env.RENTAL_SECRET;
  if (Boolean(hub) !== Boolean(secret)) throw new Error("RENTAL_HUB_URL and RENTAL_SECRET must be configured together");
  if (hub) {
    try { new URL(hub); } catch { throw new Error("RENTAL_HUB_URL must be a URL"); }
    if (!config.rental?.secrets.length) throw new Error("RENTAL_SECRET must contain a secret");
  }
}
