# Changelog

## 0.5.0 - 2026-10-16

### Added
- Automated Binance Pay, BEP20, and TRC20 plan verification and activation.
- Original-message archive delivery for campaigns, with payment schema migration.

### Fixed
- Standalone plans remain isolated from rental entitlement synchronization.
- Message and inline results are scoped to the requesting Telegram user.
- Plan expiry applies free-tier limits to stored accounts and campaigns.

## 0.4.0 - 2026-10-16

### Added
- Standalone Telegram bot dashboard with userbot, group, campaign, and plan panels.
- Free, Pro, and Business standalone plan limits, membership gating, and group promotion scheduling.
- Campaign text and entity persistence, interval selection, and optional inline bot posting.
- Paid-plan request UI and expiry handling.

## 0.3.1 - 2026-09-19

### Fixed
- Account reactivation respects the current plan cap and stale adapters are discarded.
- Group and target capacity checks are committed atomically.
- The owner UI loads Telegram authentication before its first API request.
- Secret rotation keeps the previous working control token until replacement validation succeeds.

## 0.3.0 - 2026-09-19

### Added
- Multiple connected Telegram user accounts with plan limits.
- Account-scoped groups, campaign senders, and serialized delivery adapters.
- Legacy single-account database migration.

## 0.2.0 - 2026-09-19

### Added
- Owner control-bot provisioning and encrypted storage from the rental secrets endpoint.
- Direct Telegram Mini App initData authentication for tenant API routes.
- Optional, explicitly enabled legacy proxy authentication fallback.

## 0.1.0 - 2026-09-19

- Initial IOAds service MVP.
