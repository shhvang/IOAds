import { createHmac } from "node:crypto";
import { config } from "./config.js";

export type PaymentMethod = "Binance" | "BEP20" | "TRC20";

export interface VerifiedPayment {
  reference: string;
  amount: number;
  canonicalId: string;
}

export function paymentMethods(): PaymentMethod[] {
  return [
    ...(config.paymentBinancePayId && config.paymentBinanceApiKey && config.paymentBinanceApiSecret ? ["Binance" as const] : []),
    ...(config.paymentBep20Address && config.paymentNoderealKey ? ["BEP20" as const] : []),
    ...(config.paymentTrc20Address && config.paymentTrongridKey ? ["TRC20" as const] : []),
  ];
}

async function binance(reference: string, createdAt: string, amount: number): Promise<VerifiedPayment | null> {
  const timeResponse = await fetch(`${config.paymentBinanceBaseUrl}/api/v3/time`, { signal: AbortSignal.timeout(10_000) });
  if (!timeResponse.ok) throw new Error(`Binance time query returned ${timeResponse.status}`);
  const serverTime = Number(((await timeResponse.json()) as { serverTime?: number }).serverTime);
  const params = new URLSearchParams({ startTime: String(Date.parse(createdAt) - 600_000), endTime: String(serverTime), limit: "100", recvWindow: "60000", timestamp: String(serverTime) });
  const signature = createHmac("sha256", config.paymentBinanceApiSecret).update(params.toString()).digest("hex");
  const response = await fetch(`${config.paymentBinanceBaseUrl}/sapi/v1/pay/transactions?${params}&signature=${signature}`, { headers: { "X-MBX-APIKEY": config.paymentBinanceApiKey }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Binance Pay query returned ${response.status}`);
  const body = (await response.json()) as { code?: string; data?: Array<Record<string, unknown>> };
  if (body.code !== "000000" || !Array.isArray(body.data)) throw new Error("Binance Pay returned an invalid response");
  const row = body.data.find((item) => [item.transactionId, item.orderId].some((id) => String(id ?? "").trim() === reference));
  if (!row || !String(row.transactionId ?? "").trim() || String(row.currency).toUpperCase() !== "USDT" || Number(row.amount) !== amount || !["SUCCESS", "SUCCESSFUL", "COMPLETED", "PAID", "PAY_SUCCESS"].includes(String(row.status ?? row.transactionStatus ?? "SUCCESS").toUpperCase())) return null;
  const receiver = String((row.receiverInfo as Record<string, unknown> | undefined)?.binanceId ?? "");
  const transactionTime = Number(row.transactionTime ?? 0);
  if (receiver !== config.paymentBinancePayId || transactionTime < Date.parse(createdAt) - 600_000 || transactionTime > serverTime + 300_000) return null;
  return { reference, amount, canonicalId: String(row.transactionId ?? reference) };
}

async function chain(method: "BEP20" | "TRC20", reference: string, createdAt: string, amount: number): Promise<VerifiedPayment | null> {
  if (method === "BEP20") {
    const response = await fetch(`https://bsc-mainnet.nodereal.io/v1/${config.paymentNoderealKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "nr_getTransactionByAddress", params: [{ address: config.paymentBep20Address, category: ["20"], contractAddress: "0x55d398326f99059ff775485246999027b3197955", pageSize: 100, order: "desc" }], id: 1 }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`BEP20 explorer returned ${response.status}`);
    const body = (await response.json()) as { result?: { transfers?: Array<Record<string, unknown>> } };
    const row = body.result?.transfers?.find((item) => String(item.hash ?? "").toLowerCase().replace(/^0x/, "") === reference.toLowerCase().replace(/^0x/, ""));
  if (!row || String(row.to).toLowerCase() !== config.paymentBep20Address.toLowerCase() || String(row.contractAddress).toLowerCase() !== "0x55d398326f99059ff775485246999027b3197955") return null;
    const received = rawAmount(String(row.value), 18);
    const timestamp = Number(row.blockTimeStamp ?? 0) * 1000;
    if (received !== amount || !Number.isFinite(timestamp) || timestamp < Date.parse(createdAt) - 600_000 || timestamp > Date.now() + 300_000 || Date.now() - timestamp < 45_000) return null;
    return { reference, amount, canonicalId: String(row.hash) };
  }
  const response = await fetch(`https://api.trongrid.io/v1/accounts/${encodeURIComponent(config.paymentTrc20Address)}/transactions/trc20?only_to=true&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&limit=100`, {
    headers: config.paymentTrongridKey ? { "TRON-PRO-API-KEY": config.paymentTrongridKey } : {}, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`TRC20 explorer returned ${response.status}`);
  const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const row = body.data?.find((item) => String(item.transaction_id ?? "").toLowerCase() === reference.toLowerCase());
  if (!row || String(row.to) !== config.paymentTrc20Address || String((row.token_info as Record<string, unknown>)?.address) !== "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t") return null;
  const info = row.token_info as Record<string, unknown>;
  const received = rawAmount(String(row.value), Number(info.decimals ?? 6)), timestamp = Number(row.block_timestamp);
  if (received !== amount || !Number.isFinite(timestamp) || timestamp < Date.parse(createdAt) - 600_000 || timestamp > Date.now() + 300_000 || Date.now() - timestamp < 60_000) return null;
  return { reference, amount, canonicalId: String(row.transaction_id) };
}

export function rawAmount(value: string, decimals: number): number {
  try {
    const raw = BigInt(value);
    return Number(raw / 10n ** BigInt(Math.max(0, decimals - 2))) / 100;
  } catch {
    return NaN;
  }
}

export async function verifyPayment(method: PaymentMethod, reference: string, createdAt: string, amount: number): Promise<VerifiedPayment | null> {
  return method === "Binance" ? binance(reference, createdAt, amount) : chain(method, reference, createdAt, amount);
}
