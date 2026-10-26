import { createClient, configure, type Client } from "tdl";
import { getTdjson } from "prebuilt-tdlib";
import type * as Td from "tdlib-types";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

configure({ tdjson: getTdjson() });

export interface TelegramDialog {
  chatId: string;
  title: string;
  username: string | null;
  kind: "group" | "channel";
}

export interface TelegramAdapter {
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  signIn(phone: string, phoneCodeHash: string, code: string, password?: string): Promise<{ session: string; userId: number; displayName: string }>;
  resumeSession(): Promise<{ userId: number; displayName: string } | null>;
  profile(): Promise<{ userId: number; displayName: string }>;
  dialogs(): Promise<TelegramDialog[]>;
  canPost(chatId: string): Promise<boolean>;
  sendMessage(chatId: string, message: string, entities?: Array<Record<string, unknown>>): Promise<void>;
  copyMessage(chatId: string, sourceChatId: string, messageId: number, requiresPremium?: boolean): Promise<void>;
  sendInline(chatId: string, query: string): Promise<void>;
  logout(): Promise<void>;
  close(): Promise<void>;
}

type AuthType = "phone" | "code" | "password";
type TdChat = Td.chat;

const sessionDirectory = (accountId: string): string => join(config.dataDir, "tdlib", createHash("sha256").update(accountId).digest("hex"));
export const hasTdlibSession = (accountId: string): boolean => existsSync(sessionDirectory(accountId)) && readdirSync(sessionDirectory(accountId)).some((file) => file !== "files");
export const removeTdlibSession = (accountId: string): void => rmSync(sessionDirectory(accountId), { recursive: true, force: true });

function chatId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error("invalid chat id");
  return id;
}

function tdEntities(entities: Array<Record<string, unknown>>): Td.textEntity[] {
  const simple: Record<string, Td.TextEntityType> = {
    mention: { _: "textEntityTypeMention" }, hashtag: { _: "textEntityTypeHashtag" }, cashtag: { _: "textEntityTypeCashtag" },
    bot_command: { _: "textEntityTypeBotCommand" }, url: { _: "textEntityTypeUrl" }, email: { _: "textEntityTypeEmailAddress" },
    phone_number: { _: "textEntityTypePhoneNumber" }, bold: { _: "textEntityTypeBold" }, italic: { _: "textEntityTypeItalic" },
    underline: { _: "textEntityTypeUnderline" }, strikethrough: { _: "textEntityTypeStrikethrough" }, spoiler: { _: "textEntityTypeSpoiler" },
    code: { _: "textEntityTypeCode" }, pre: { _: "textEntityTypePre" }, blockquote: { _: "textEntityTypeBlockQuote" },
    expandable_blockquote: { _: "textEntityTypeExpandableBlockQuote" },
  };
  const result: Td.textEntity[] = [];
  for (const entity of entities) {
    const offset = Number(entity.offset), length = Number(entity.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) continue;
    let type = simple[String(entity.type)];
    if (entity.type === "text_link" && typeof entity.url === "string") type = { _: "textEntityTypeTextUrl", url: entity.url };
    if (entity.type === "text_mention" && entity.user && typeof entity.user === "object" && Number.isSafeInteger((entity.user as { id?: number }).id)) type = { _: "textEntityTypeMentionName", user_id: (entity.user as { id: number }).id };
    if (entity.type === "custom_emoji" && entity.custom_emoji_id) type = { _: "textEntityTypeCustomEmoji", custom_emoji_id: String(entity.custom_emoji_id) };
    if (entity.type === "pre" && typeof entity.language === "string") type = { _: "textEntityTypePreCode", language: entity.language };
    if (type) result.push({ _: "textEntity", offset, length, type });
  }
  return result;
}

export function createTelegramAdapter(accountId: string): TelegramAdapter {
  if (!config.telegramApiId || !config.telegramApiHash) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before login");
  const directory = sessionDirectory(accountId);
  mkdirSync(directory, { recursive: true });
  let client: Client | null = null;
  let userId = 0;
  let displayName = "";
  let userPremium = false;
  let authReadyDone = false;
  let previouslyAuthorized = false;
  let authError: Error | null = null;
  let authPhase: AuthType | "ready" | "closed" = "phone";
  let firstAuthResolve!: () => void;
  const firstAuth = new Promise<void>((resolve) => { firstAuthResolve = resolve; });
  let phaseVersion = 0;
  const authWaiters = new Map<AuthType, { resolve(value: string): void; reject(error: Error): void }>();
  const authInputs = new Map<AuthType, string>();
  const authRequests: Record<AuthType, number> = { phone: 0, code: 0, password: 0 };
  const phaseWaiters: Array<{ phases: Array<AuthType | "ready" | "closed">; resolve(): void }> = [];
  let authReadyResolve!: () => void;
  let authReadyReject!: (error: Error) => void;
  const authReady = new Promise<void>((resolve, reject) => { authReadyResolve = resolve; authReadyReject = reject; });
  void authReady.catch(() => undefined);
  const sendWaiters = new Map<number, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const sendResults = new Map<number, { error: Error | null; at: number }>();
  const sendError = (code: number, message: string): Error => new Error(`Telegram ${code}: ${message}`);
  const finishSend = (temporaryId: number, error: Error | null): void => {
    const waiter = sendWaiters.get(temporaryId);
    if (waiter) {
      clearTimeout(waiter.timer);
      sendWaiters.delete(temporaryId);
      if (error) waiter.reject(error); else waiter.resolve();
    } else sendResults.set(temporaryId, { error, at: Date.now() });
    if (sendResults.size > 1000) for (const [id, result] of sendResults) if (Date.now() - result.at > 60_000) sendResults.delete(id);
  };
  const confirmed = async (message: Td.message): Promise<void> => {
    if (message.sending_state?._ === "messageSendingStateFailed") throw sendError(message.sending_state.error.code, message.sending_state.error.message);
    if (message.sending_state?._ !== "messageSendingStatePending") return;
    const result = sendResults.get(message.id);
    if (result) {
      sendResults.delete(message.id);
      if (result.error) throw result.error;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sendWaiters.delete(message.id);
        reject(new Error("sender confirmation timeout"));
      }, 65_000);
      sendWaiters.set(message.id, { resolve, reject, timer });
    });
  };
  const ask = (type: AuthType): Promise<string> => {
    const value = authInputs.get(type);
    if (value !== undefined) { authInputs.delete(type); return Promise.resolve(value); }
    return new Promise((resolve, reject) => authWaiters.set(type, { resolve, reject }));
  };
  const provide = (type: AuthType, value: string): void => {
    const waiter = authWaiters.get(type);
    if (waiter) { authWaiters.delete(type); waiter.resolve(value); }
    else authInputs.set(type, value);
  };
  const waitAuth = (type: AuthType): Promise<string> => { authRequests[type] += 1; return ask(type); };
  const waitForPhase = async (...phases: Array<AuthType | "ready" | "closed">): Promise<void> => {
    if (phases.includes(authPhase)) return;
    await new Promise<void>((resolve) => phaseWaiters.push({ phases, resolve }));
  };
  const setPhase = (phase: typeof authPhase): void => {
    authPhase = phase;
    phaseVersion += 1;
    for (let i = phaseWaiters.length - 1; i >= 0; i -= 1) if (phaseWaiters[i]!.phases.includes(phase)) phaseWaiters.splice(i, 1)[0]!.resolve();
  };
  const currentPhase = (): typeof authPhase => authPhase;
  const td = createClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    databaseDirectory: directory,
    filesDirectory: join(directory, "files"),
    databaseEncryptionKey: config.sessionEncryptionKey,
  });
  client = td;
  td.on("error", (error) => { authError = error; authReadyReject(error); });
  td.on("update", (update) => {
    if (update._ === "updateMessageSendSucceeded") finishSend(update.old_message_id, null);
    if (update._ === "updateMessageSendFailed") finishSend(update.old_message_id, sendError(update.error.code, update.error.message));
    if (update._ === "updateAuthorizationState") {
      const state = update.authorization_state;
      if (["authorizationStateWaitPhoneNumber", "authorizationStateWaitCode", "authorizationStateWaitPassword", "authorizationStateClosed", "authorizationStateReady"].includes(state._)) firstAuthResolve();
      if (state._ === "authorizationStateWaitPhoneNumber") setPhase("phone");
      if (state._ === "authorizationStateWaitCode") setPhase("code");
      if (state._ === "authorizationStateWaitPassword") setPhase("password");
      if (state._ === "authorizationStateClosed") setPhase("closed");
      if (state._ === "authorizationStateReady") {
        setPhase("ready");
        previouslyAuthorized = true;
        void td.invoke({ _: "getMe" }).then((me) => { userId = me.id; displayName = [me.first_name, me.last_name].filter(Boolean).join(" ").trim(); userPremium = me.is_premium; authReadyDone = true; authReadyResolve(); }).catch(authReadyReject);
      }
    }
  });
  const login = td.login({
    getPhoneNumber: () => waitAuth("phone"),
    getAuthCode: () => waitAuth("code"),
    getPassword: () => waitAuth("password"),
    getEmailAddress: () => Promise.reject(new Error("email login is not supported yet")),
    getEmailCode: () => Promise.reject(new Error("email login is not supported yet")),
  });
  void login.catch((error) => { authError = error; authReadyReject(error); });
  const ready = async (): Promise<Client> => { await authReady; return td; };
  return {
    async resumeSession() {
      await Promise.race([firstAuth, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("Telegram session check timed out")), 15_000))]);
      if (authPhase !== "ready") return null;
      await Promise.race([ready(), new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("Telegram session check timed out")), 15_000))]);
      return { userId, displayName };
    },
    async profile() {
      const current = await ready();
      const me = await current.invoke({ _: "getMe" });
      userId = me.id;
      displayName = [me.first_name, me.last_name].filter(Boolean).join(" ").trim();
      userPremium = me.is_premium;
      return { userId, displayName };
    },
    async sendCode(phone) {
      await waitForPhase("phone", "closed");
      if (previouslyAuthorized) throw new Error("This account is already connected");
      if (authPhase !== "phone") throw new Error("Telegram is not ready for a phone number");
      provide("phone", phone);
      await waitForPhase("code", "closed");
      if (authError) throw authError;
       if (currentPhase() === "closed") throw new Error("Telegram closed the login session");
      return { phoneCodeHash: "tdlib" };
    },
    async signIn(_phone, _hash, code, password) {
      authError = null;
      if (authPhase === "password") {
        if (!password) throw new Error("SESSION_PASSWORD_NEEDED");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const request = authRequests.password;
        provide("password", password);
        while (authRequests.password === request && !["ready", "closed"].includes(currentPhase())) await new Promise((resolve) => setTimeout(resolve, 50));
        if (authRequests.password > request) throw new Error("PASSWORD_HASH_INVALID");
      } else if (authPhase === "code") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const request = authRequests.code;
        provide("code", code);
        while (authRequests.code === request && !["ready", "password", "closed"].includes(currentPhase())) await new Promise((resolve) => setTimeout(resolve, 50));
        if (authRequests.code > request) throw new Error("PHONE_CODE_INVALID");
        if (currentPhase() === "password") throw new Error("SESSION_PASSWORD_NEEDED");
      } else throw new Error("Telegram is not waiting for a login code");
      if (currentPhase() === "closed") throw new Error("Telegram closed the login session");
      await ready();
      return { session: `tdlib:${accountId}`, userId, displayName };
    },
    async dialogs() {
      const current = await ready();
      const ids = new Set<number>();
      for (const chatList of [{ _: "chatListMain" } as const, { _: "chatListArchive" } as const]) {
        while (true) {
          try { await current.invoke({ _: "loadChats", chat_list: chatList, limit: 100 }); }
          catch (error) {
            if (/\b404\b/.test(String(error))) break;
            throw error;
          }
        }
        const chats = await current.invoke({ _: "getChats", chat_list: chatList, limit: 1_000_000 });
        for (const id of chats.chat_ids) ids.add(id);
      }
      const result: TelegramDialog[] = [];
      const all = [...ids];
      for (let offset = 0; offset < all.length; offset += 25) {
        const batch = await Promise.all(all.slice(offset, offset + 25).map((id) => current.invoke({ _: "getChat", chat_id: id }) as Promise<TdChat>));
        for (const chat of batch) {
          if (chat.type._ !== "chatTypeBasicGroup" && chat.type._ !== "chatTypeSupergroup") continue;
          result.push({ chatId: String(chat.id), title: chat.title, username: null, kind: chat.type._ === "chatTypeSupergroup" && chat.type.is_channel ? "channel" : "group" });
        }
      }
      return result;
    },
    async canPost(target) {
      const current = await ready(), id = chatId(target), chat = await current.invoke({ _: "getChat", chat_id: id });
      const me = await current.invoke({ _: "getMe" });
      const member = await current.invoke({ _: "getChatMember", chat_id: id, member_id: { _: "messageSenderUser", user_id: me.id } });
      if (chat.type._ === "chatTypeSupergroup" && chat.type.is_channel) return false;
      if (member.status._ === "chatMemberStatusCreator") return true;
      if (member.status._ === "chatMemberStatusAdministrator")
        return chat.type._ !== "chatTypeSupergroup" || !chat.type.is_channel || member.status.rights.can_post_messages;
      if (chat.type._ === "chatTypeSupergroup" && chat.type.is_channel) {
        return false;
      }
      if (member.status._ === "chatMemberStatusRestricted") return member.status.is_member && member.status.permissions.can_send_basic_messages;
      return member.status._ === "chatMemberStatusMember" && chat.permissions.can_send_basic_messages;
    },
    async sendMessage(target, message, entities) {
      const current = await ready();
      const formatted = { _: "formattedText" as const, text: message, entities: entities?.length ? tdEntities(entities) : [] };
      if (!userPremium && formatted.entities.some((entity) => entity.type._ === "textEntityTypeCustomEmoji"))
        throw new Error("Connected Telegram account needs Premium to send custom emoji. Choose a Premium account or remove the custom emoji.");
      const sent = await current.invoke({ _: "sendMessage", chat_id: chatId(target), input_message_content: { _: "inputMessageText", text: formatted, clear_draft: false } });
      await confirmed(sent);
    },
    async copyMessage(target, sourceChat, messageId, requiresPremium) {
      const current = await ready();
      if (requiresPremium && !userPremium)
        throw new Error("Connected Telegram account needs Premium to send custom emoji. Choose a Premium account or remove the custom emoji.");
      const sourceId = sourceChat.startsWith("@")
        ? (await current.invoke({ _: "searchPublicChat", username: sourceChat.slice(1) })).id
        : chatId(sourceChat);
      const tdMessageId = messageId * 1_048_576;
      if (!Number.isSafeInteger(tdMessageId)) throw new Error("invalid archive message id");
      const copied = await current.invoke({ _: "forwardMessages", chat_id: chatId(target), from_chat_id: sourceId, message_ids: [tdMessageId], send_copy: true, remove_caption: false });
      if (!copied.messages[0]) throw new Error("Telegram could not copy this message");
      await confirmed(copied.messages[0]);
    },
    async sendInline(target, query) {
      const current = await ready();
      const bot = await current.invoke({ _: "searchPublicChat", username: config.botUsername });
      const results = await current.invoke({ _: "getInlineQueryResults", bot_user_id: bot.id, chat_id: chatId(target), query, offset: "" });
      const result = results.results[0];
      if (!result) throw new Error("inline campaign result unavailable");
      const sent = await current.invoke({ _: "sendInlineQueryResultMessage", chat_id: chatId(target), query_id: results.inline_query_id, result_id: result.id, hide_via_bot: false });
      await confirmed(sent);
    },
    async logout() {
      const current = client;
      for (const waiter of authWaiters.values()) waiter.reject(new Error("login cancelled"));
      authWaiters.clear();
      for (const type of ["phone", "code", "password"] as const) authInputs.delete(type);
      for (const waiter of phaseWaiters.splice(0)) waiter.resolve();
      for (const waiter of sendWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("sender client closed")); }
      sendWaiters.clear();
      sendResults.clear();
      setPhase("closed");
      if (!current || current.isClosed()) { client = null; rmSync(directory, { recursive: true, force: true }); return; }
      let loggedOut = !authReadyDone;
      try {
        if (authReadyDone) { await current.invoke({ _: "logOut" }); loggedOut = true; }
      } finally {
        try { await current.close(); }
        finally {
          client = null;
          if (loggedOut) rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    async close() {
      const current = client;
      for (const waiter of authWaiters.values()) waiter.reject(new Error("sender client closed"));
      authWaiters.clear();
      for (const type of ["phone", "code", "password"] as const) authInputs.delete(type);
      for (const waiter of phaseWaiters.splice(0)) waiter.resolve();
      for (const waiter of sendWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("sender client closed")); }
      sendWaiters.clear();
      sendResults.clear();
      setPhase("closed");
      if (current && !current.isClosed()) await current.close();
      client = null;
    },
  };
}

export class FakeTelegramAdapter implements TelegramAdapter {
  readonly sent: Array<{ chatId: string; message: string }> = [];
  readonly inlineSent: Array<{ chatId: string; query: string }> = [];
  readonly groups: TelegramDialog[] = [];
  async sendCode(_phone: string): Promise<{ phoneCodeHash: string }> { return { phoneCodeHash: "fake-hash" }; }
  async signIn(_phone: string, _phoneCodeHash: string, _code: string, _password?: string): Promise<{ session: string; userId: number; displayName: string }> { return { session: "fake-session", userId: 1, displayName: "Test Account" }; }
  async resumeSession(): Promise<{ userId: number; displayName: string } | null> { return { userId: 1, displayName: "Test Account" }; }
  async profile(): Promise<{ userId: number; displayName: string }> { return { userId: 1, displayName: "Test Account" }; }
  async dialogs(): Promise<TelegramDialog[]> { return this.groups; }
  async canPost(_chatId: string): Promise<boolean> { return true; }
  async sendMessage(chatId: string, message: string, _entities?: Array<Record<string, unknown>>): Promise<void> { this.sent.push({ chatId, message }); }
  async copyMessage(chatId: string, _sourceChatId: string, _messageId: number): Promise<void> { this.sent.push({ chatId, message: "[copied message]" }); }
  async sendInline(chatId: string, query: string): Promise<void> { this.inlineSent.push({ chatId, query }); }
  async logout(): Promise<void> {}
  async close(): Promise<void> {}
}
