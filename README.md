# IOAds

IOAds is a standalone Telegram bot and service for scheduled Telegram group campaigns from
multiple connected Telegram user accounts within each plan's limit.
It uses Node.js, TypeScript, Express, GramJS, and a persistent SQLite database.

## Run

```sh
npm install
npm run typecheck
npm test
npm run build
npm start
```

Copy `.env.example` to `.env`. Set `BOT_TOKEN`, `BOT_OWNER_ID`, and `ADS_ARCHIVE_CHAT` for the standalone bot. The bot must be an admin of `ADS_ARCHIVE_CHAT`, and each connected userbot must be a member with permission to view and forward from it. Grant the bot permission to post in `ADS_PROMO_CHAT` and verify membership checks work for `ADS_FORCE_JOIN_CHAT`. `RENTAL_HUB_URL` and `RENTAL_SECRET` are optional. Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and
`SESSION_ENCRYPTION_KEY` for real account login. Configure one or more payment methods with `BINANCE_PAY_ID` plus read-only API credentials, or receiving addresses plus the corresponding explorer API key. The SQLite file is
`DATA_DIR/ads.db` and should be mounted at `/app/data` in production.
Plan payments are automatically verified against Binance Pay, BEP20, or TRC20 transaction history. Paid tiers are activated for 30 days after exact amount, destination, transaction status, time window, and uniqueness checks pass.
Set `RENTAL_SECRET` to comma-separated values during rotation; the first is
used outbound and every configured value is accepted inbound. Set
`ADS_ENTRY_URL` to the public service URL so the manifest links to `/`.
IOAds runs independently when `RENTAL_HUB_URL` and `RENTAL_SECRET` are unset.
Set both only when connecting it to the rental hub; standalone bot users and
hub-provisioned tenants remain separate.

Free-tier deliveries are copied by the control bot from the archive. Paid
campaigns with inline mode enabled are sent when the connected userbot selects
the campaign from the bot's inline results; set `ADS_BOT_USERNAME` to the bot's
username and enable inline mode for that bot in BotFather. Other paid deliveries
copy through the connected userbot, which needs access to the archive chat.

## Authentication boundary

The rental hub collects an owner control-bot token and sends it through the
contract secrets endpoint. Ads encrypts that token with `SESSION_ENCRYPTION_KEY`
before storing it and verifies the `X-Telegram-Init-Data` header on every
`/api/tenants/:tenantId` request. The Telegram user in initData must match the
tenant owner, and cancelled or blocked tenants are rejected. The service never
returns or logs the bot token.

When a trusted proxy cannot forward initData, set `ADS_OWNER_AUTH_SECRET` and
`ADS_OWNER_AUTH_FALLBACK=true` to enable the legacy HMAC headers as a temporary
fallback. This fallback still requires a provisioned control-bot token and is
not the primary authentication path. The Mini App supplies initData
automatically when opened in Telegram; outside Telegram, an approved proxy must
inject the fallback headers so users never have to compute signatures.

## API

All tenant routes are under `/api/tenants/:tenantId` and require the owner
boundary above. Routes include account list/login/code/password/logout/delete,
groups sync and enable/disable, campaign and target CRUD, schedule/pause/cancel,
and delivery history. Telegram login stores only an encrypted persistent
GramJS session; passwords, codes, and sessions are never returned.

Groups are limited to dialogs already visible to the connected user account.
The service does not join groups, scrape members, discover chats, or send DMs.

Tier ranks are explicit: `starter` is rank 1, `pro` rank 2, and `business` rank
3. Group message overrides are persisted, but create/update rejects them below
rank 2 and the scheduler ignores them below rank 2.

Delivery claims use a stable occurrence key and are at-least-once: a process
crash after Telegram accepts a message but before SQLite marks it sent can
still cause a later retry.
