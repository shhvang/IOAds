/**
 * The rental provisioning contract, v1. Types and the two pieces of behaviour
 * both sides must implement identically (secret comparison, secret fingerprint).
 *
 * This file is COPIED, not imported. Canonical copy: bots/_docs/rental-contract.ts.
 * Copy paths and the drift check are in RENTAL_CONTRACT.md §11. Do not edit a copy.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const CONTRACT_REVISION = "1.0.0";

/** Path prefix every endpoint on both sides lives under. */
export const CONTRACT_PREFIX = "/rental/v1";

/** Header both sides send on every request and response. */
export const CONTRACT_HEADER = "x-rental-contract";

export type TenantState = "pending" | "active" | "suspended" | "cancelled" | "purged";

/** `unpaid` may keep a closed-notice bot up; `blocked` must go fully dark. */
export type SuspendReason = "unpaid" | "blocked" | "owner";

/** Which side runs this tenant. Exactly one, never both. */
export type Runtime = "hub" | "service";

export interface TenantDesiredState {
  tenantId: string;
  productId: string;
  ownerTelegramId: number;
  state: TenantState;
  /** Tier code, scoped to `productId`. Must exist in the product's manifest. */
  tierCode: string;
  runtime: Runtime;
  /** Monotone per hub. Higher wins, equal is a no-op, lower is `stale_version`. */
  version: number;
  trial: boolean;
  suspendReason: SuspendReason | null;
  /** ISO-8601 Z. End of the paid period; null while pending or cancelled. */
  periodEnd: string | null;
  /** ISO-8601 Z. Tenant data must survive until this instant. */
  retainUntil: string | null;
  /** Resolved limits for this tenant — the hub's word, not the tier table's. */
  limits: Record<string, number>;
  /** `fingerprint()` of the secret bundle, or null when the product needs none. */
  secretsFingerprint: string | null;
  /** Refuse with `not_ready` unless this side already holds the tenant's data. */
  expectData: boolean;
  /** Product-specific configuration synced from hub to service. */
  config: Record<string, any>;
  updatedAt: string;
}

export interface TenantRuntimeState {
  tenantId: string;
  /** The desired-state `version` this side has actually applied. */
  version: number;
  running: boolean;
  /** Applying in the background; `running` is not yet final. */
  applying: boolean;
  /** Why it is not running when it should be. Never carries a secret. */
  fault: string | null;
  usage: Record<string, number>;
  hasData: boolean;
  /** What to call this tenant on the hub's screens (a bot @username, no @). */
  label?: string | null;
  observedAt: string;
}

export type ProvisioningFieldKind = "bot_token" | "telegram_ids" | "text" | "channel";

export interface ProvisioningField {
  key: string;
  kind: ProvisioningFieldKind;
  label: string;
  hint?: string;
  required: boolean;
  /** Travels only through the secrets endpoint, never the feed or a push. */
  secret: boolean;
}

export interface TierManifest {
  code: string;
  label: string;
  blurb: string;
  /** A limit key matching a usage key renders as used/limit on the dashboard. */
  limits: Record<string, number>;
  /** Rendered under the tier on the picker, in order. */
  lines: string[];
  listed: boolean;
}

export interface UsageKey {
  key: string;
  label: string;
  format: "count" | "usd";
}

export interface ProductManifest {
  contract: string;
  contractSha256: string;
  productId: string;
  label: string;
  blurb: string;
  /** One subscription per owner. */
  singleton: boolean;
  /** The hub may still run this product in its own process (strangler only). */
  hubRunnable: boolean;
  tiers: TierManifest[];
  defaultTier: string;
  provisioning: { fields: ProvisioningField[] };
  usageKeys: UsageKey[];
  /** Where the hub sends an owner to use the product. */
  entryUrl: string | null;
  nextSteps: string[];
  /** Demo bot username (without @) for users to try before subscribing. */
  demoBot?: string;
  /** Platform-wide blockchain API keys for payment verification. */
  chainKeys?: { nodereal?: string; trongrid?: string };
}

export interface EntitlementFeed {
  contract: string;
  generatedAt: string;
  /** true = authoritative snapshot: anything absent is not entitled here. */
  full: boolean;
  /** Highest `version` in this page; the next `since` cursor. */
  seq: number;
  tenants: TenantDesiredState[];
  nextCursor: number | null;
}

export interface TenantSecrets {
  tenantId: string;
  version: number;
  fingerprint: string;
  /** Keyed by `ProvisioningField.key`. Absent key = not set by the owner. */
  values: Record<string, string>;
}

export interface ProductHealth {
  ok: boolean;
  contract: string;
  contractSha256: string;
  productId: string;
  tenantsDesired: number;
  tenantsRunning: number;
  lastFeedSyncAt: string | null;
  /** Highest desired-state `version` this product has applied. */
  seq: number;
}

export type ContractErrorCode =
  | "bad_request"
  | "unauthorized"
  | "unknown_tenant"
  | "stale_version"
  | "not_ready"
  | "unsupported_tier"
  | "rate_limited"
  | "unavailable"
  | "internal";

export interface ContractError {
  error: {
    code: ContractErrorCode;
    message: string;
    /** The caller may retry with backoff. 4xx other than `rate_limited` is false. */
    retryable: boolean;
  };
}

/** The bearer token from an Authorization header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer +(\S+)$/.exec(header ?? "");
  return match?.[1];
}

/**
 * Constant-time secret comparison. Digests first so unequal lengths neither
 * throw nor leak: `timingSafeEqual` requires equal-length buffers.
 */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Stable fingerprint of a secret bundle. Both sides must produce the same
 * string for the same values, or the product refetches secrets forever.
 */
export function fingerprint(values: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(values)
      .sort()
      .map((key) => [key, values[key]]),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/** How a receiver decides what to do with an incoming desired state. */
export function versionVerdict(incoming: number, stored: number): "apply" | "noop" | "stale" {
  if (incoming > stored) return "apply";
  if (incoming === stored) return "noop";
  return "stale";
}

/** Whether a desired state means "serve customers right now". */
export function shouldRun(desired: TenantDesiredState, side: Runtime): boolean {
  if (desired.runtime !== side) return false;
  if (desired.state === "active") return true;
  return desired.state === "suspended" && desired.suspendReason === "unpaid";
}

// --- contract-hash: everything above this line is hashed ---
export const CONTRACT_SHA256 = "d9aefee9331bc3065af626bd5e22b16d";
