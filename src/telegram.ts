import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { randomBytes } from "node:crypto";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";
import { unseal } from "./lib/crypto.js";

export interface TelegramDialog {
  chatId: string;
  title: string;
  username: string | null;
}

export interface TelegramAdapter {
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  signIn(phone: string, phoneCodeHash: string, code: string, password?: string): Promise<{ session: string; userId: number }>;
  dialogs(): Promise<TelegramDialog[]>;
  canPost(chatId: string): Promise<boolean>;
  sendMessage(chatId: string, message: string, entities?: Array<Record<string, unknown>>): Promise<void>;
  copyMessage(chatId: string, sourceChatId: string, messageId: number): Promise<void>;
  sendInline(chatId: string, query: string): Promise<void>;
  logout(): Promise<void>;
}

type Client = TelegramClient & { _connected?: boolean };

export function createTelegramAdapter(encryptedSession: string | null): TelegramAdapter {
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before login");
  if (!config.telegramApiId || !config.telegramApiHash) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  let client: Client | null = null;
  let phoneCodeHash = "";
  const connect = async (session: string): Promise<Client> => {
    const next = new TelegramClient(new StringSession(session), config.telegramApiId, config.telegramApiHash, { connectionRetries: 2 }) as Client;
    await next.connect();
    client = next;
    return next;
  };
  const existing = encryptedSession ? unseal(encryptedSession, config.sessionEncryptionKey) : null;
  return {
    async sendCode(phone) {
      const current = await connect(existing ?? "");
      const sent = await current.sendCode({ apiId: config.telegramApiId, apiHash: config.telegramApiHash }, phone);
      phoneCodeHash = sent.phoneCodeHash;
      return { phoneCodeHash };
    },
    async signIn(phone, hash, code, password) {
      const current = client ?? await connect(existing ?? "");
      let self;
      try {
        self = await current.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: code }));
      } catch (error) {
        if (!password || !String(error).includes("SESSION_PASSWORD_NEEDED")) throw error;
        self = await current.signInWithPassword(
          { apiId: config.telegramApiId, apiHash: config.telegramApiHash },
          { password: async () => password, onError: (passwordError) => { throw passwordError; } },
        );
      }
      const user = await current.getMe();
      return { session: (current.session as StringSession).save(), userId: Number(user?.id) };
    },
    async dialogs() {
      const current = client ?? await connect(existing ?? "");
      const result: TelegramDialog[] = [];
      for await (const dialog of current.iterDialogs({})) {
        const entity = dialog.entity as { id?: unknown; title?: unknown; username?: unknown } | undefined;
        const isGroup = entity instanceof Api.Chat || (entity instanceof Api.Channel && Boolean((entity as Api.Channel).megagroup));
        if (entity?.id === undefined || typeof entity.title !== "string" || !isGroup) continue;
        const username = "username" in entity && typeof entity.username === "string" ? entity.username : null;
        result.push({ chatId: String(entity.id), title: entity.title, username });
      }
      return result;
    },
    async canPost(chatId) {
      const current = client ?? await connect(existing ?? "");
      const entity = await current.getEntity(chatId) as Api.Chat | Api.Channel;
      const admin = "adminRights" in entity ? entity.adminRights : undefined;
      const banned = "bannedRights" in entity ? entity.bannedRights : undefined;
      const defaults = entity.defaultBannedRights;
      if (banned?.sendMessages) return false;
      if (admin?.postMessages === false) return false;
      if (entity instanceof Api.Channel && !entity.megagroup && !entity.creator && !admin?.postMessages) return false;
      if (defaults?.sendMessages && !admin && !(entity instanceof Api.Chat && entity.creator)) return false;
      return true;
    },
    async sendMessage(chatId, message, entities) {
      const current = client ?? await connect(existing ?? "");
      await current.sendMessage(chatId, { message, formattingEntities: entities as never });
    },
    async copyMessage(chatId, sourceChatId, messageId) {
      const current = client ?? await connect(existing ?? "");
      const randomId = BigInt.asIntN(64, randomBytes(8).readBigUInt64LE());
      await current.invoke(new Api.messages.ForwardMessages({ fromPeer: await current.getInputEntity(sourceChatId), id: [messageId], randomId: [bigInt(randomId.toString())], toPeer: await current.getInputEntity(chatId), dropAuthor: true, dropMediaCaptions: false }));
    },
    async sendInline(chatId, query) {
      if (!config.botUsername) throw new Error("ADS_BOT_USERNAME is required for inline sending");
      const current = client ?? await connect(existing ?? "");
      const results = await current.inlineQuery(config.botUsername, `campaign:${query}`);
      const result = results[0];
      if (!result) throw new Error("inline campaign result unavailable");
      await result.click(chatId);
    },
    async logout() {
      if (client) {
        try { await client.invoke(new Api.auth.LogOut()); } finally { await client.disconnect(); }
      }
      client = null;
    },
  };
}

export class FakeTelegramAdapter implements TelegramAdapter {
  readonly sent: Array<{ chatId: string; message: string }> = [];
  readonly inlineSent: Array<{ chatId: string; query: string }> = [];
  readonly groups: TelegramDialog[] = [];
  async sendCode(_phone: string): Promise<{ phoneCodeHash: string }> { return { phoneCodeHash: "fake-hash" }; }
  async signIn(_phone: string, _phoneCodeHash: string, _code: string, _password?: string): Promise<{ session: string; userId: number }> { return { session: "fake-session", userId: 1 }; }
  async dialogs(): Promise<TelegramDialog[]> { return this.groups; }
  async canPost(_chatId: string): Promise<boolean> { return true; }
  async sendMessage(chatId: string, message: string, _entities?: Array<Record<string, unknown>>): Promise<void> { this.sent.push({ chatId, message }); }
  async copyMessage(chatId: string, _sourceChatId: string, _messageId: number): Promise<void> { this.sent.push({ chatId, message: "[copied message]" }); }
  async sendInline(chatId: string, query: string): Promise<void> { this.inlineSent.push({ chatId, query }); }
  async logout(): Promise<void> {}
}
