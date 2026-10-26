# IOAds

IOAds is a standalone Telegram bot and service for scheduled Telegram group campaigns from
multiple connected Telegram user accounts within each plan's limit.
It uses Node.js, TypeScript, Express, TDLib, and a persistent SQLite database.

## Run

```sh
npm install
npm run typecheck
npm test
npm run build
npm start
```

Copy `.env.example` to `.env`. Set `BOT_TOKEN`, `BOT_OWNER_ID`, and `ADS_ARCHIVE_CHAT` for the standalone bot. The bot must be an admin of `ADS_ARCHIVE_CHAT`; for direct media copying, each connected account must be able to view and forward from it. Verify membership checks work for `ADS_FORCE_JOIN_CHAT`. `RENTAL_HUB_URL` and `RENTAL_SECRET` are optional. Set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and
`SESSION_ENCRYPTION_KEY` for real account login and TDLib's encrypted local account database. Configure one or more payment methods with `BINANCE_PAY_ID` plus read-only API credentials, or receiving addresses plus the corresponding explorer API key. The SQLite file is
`DATA_DIR/ads.db` and should be mounted at `/app/data` in production.
Plan payments are automatically verified against Binance Pay, BEP20, or TRC20 transaction history. Paid tiers are activated for 30 days after exact amount, destination, transaction status, time window, and uniqueness checks pass.
Set `RENTAL_SECRET` to comma-separated values during rotation; the first is
used outbound and every configured value is accepted inbound. Set
`ADS_ENTRY_URL` to the public service URL so the manifest links to `/`.
IOAds runs independently when `RENTAL_HUB_URL` and `RENTAL_SECRET` are unset.
Set both only when connecting it to the rental hub; standalone bot users and
hub-provisioned tenants remain separate.

With `ADS_BOT_USERNAME` configured and inline mode enabled in BotFather, new
text, supported media, and rich-message campaigns use one private inline result
per campaign. The inline payload retains its entities, rich blocks, cached media,
captions, link preview settings, and inline keyboard. Empty or ordinary inline
queries show one IOAds feature result and a button to open the bot in private
chat; campaign content is returned only for an explicit authorized campaign
query. Inline campaign posts add one small "posted by IOAds" button linking to
the bot's private chat, with the IOAds logo custom emoji as its icon. The
original content and buttons remain intact. Telegram may restrict custom emoji
icons in inline results to bots with an additional username purchased on
Fragment; if Telegram rejects the icon, the bot retries with the same button
without the icon. Direct copies cannot carry this button. The bot reports failed
deliveries if Telegram rejects them; it does not replace the post with altered
text.

Set `ADS_ARCHIVE_CHAT` to a private chat accessible to the connected accounts
when direct copies or media features unsupported by inline mode are needed.
The bot archives incoming posts there and connected accounts copy from it.
Albums are refused because Telegram delivers their items separately. The
archive must be separate from every campaign target. Without an archive,
posts that cannot be sent intact through inline mode are refused at creation.
The standalone plans allow 2,000 daily messages on Free, 5,000 on Pro ($1),
and 15,000 on Business ($3), with 1, 5, and 15 connected account slots. A
connected sender must be a different Telegram account from the one operating
the bot. Existing matching sessions are disconnected when the service starts.

Campaigns stay as drafts until at least one group is selected and Schedule is
pressed. The bot shows this action after group selection. Group lists are read
from the local cache during setup; Refresh groups performs a full Telegram
sync only when requested. Activity shows delivery failures and retry times.

The scheduler runs in a separate supervised process and stores work in SQLite.
`ADS_DELIVERY_CONCURRENCY` sets the number of deliveries it can issue in one
pass; `ADS_WORKER_COUNT` sets the number of supervised sender processes. Each
account always maps to the same sender process. A sender crash restarts that
process and queued deliveries are retried. `ADS_WORKER_IDLE_MS` closes idle
TDLib clients to reduce memory use. The control bot uses concurrent polling;
using a webhook for that one bot would not change user account delivery, which
uses TDLib connections rather than Bot API polling.

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
and delivery history. TDLib keeps each account's encrypted local database under
`DATA_DIR/tdlib`; bot login codes, passwords, and TDLib keys are never returned.
Existing GramJS sessions must be connected again; new TDLib sessions persist.

Groups are limited to dialogs already visible to the connected user account.
The service does not join groups, scrape members, discover chats, or send DMs.

Tier ranks are explicit: `free` and `starter` are rank 0, `pro` is rank 1,
and `business` is rank 2. Group message overrides are persisted, but
create/update rejects them below rank 1 and the scheduler ignores them there.

Delivery claims use a stable occurrence key and are at-least-once: a process
crash after Telegram accepts a message but before SQLite marks it sent can
still cause a later retry.
