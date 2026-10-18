# IOAds Service

IOAds is the `ads` rental product. It owns tenant-isolated campaign data and
sends scheduled messages from connected Telegram user accounts per tenant.

The rental hub owns subscriptions and desired state. This service owns runtime
data, Telegram sessions, group selection, campaign scheduling, and delivery
history. It never joins chats, scrapes members, sends DMs, or discovers groups.

The owner control bot token arrives through the rental secrets endpoint and is
stored encrypted with `SESSION_ENCRYPTION_KEY`. Mini App API routes verify
`X-Telegram-Init-Data` against that token and the tenant's desired owner id.
The old proxy headers remain an opt-in fallback with `ADS_OWNER_AUTH_FALLBACK=true`.
Without a provisioned token, the API fails closed.

`SESSION_ENCRYPTION_KEY` encrypts TDLib local account databases. Telegram API
credentials and account sessions are never returned or logged.
