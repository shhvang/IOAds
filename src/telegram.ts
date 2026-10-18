import { createClient, configure, type Client } from "tdl";
import { getTdjson } from "prebuilt-tdlib";
import type * as Td from "tdlib-types";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

configure({ tdjson: getTdjson() });

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

type AuthType = "phone" | "code" | "password";
type TdChat = Td.chat;

const sessionRoot = join(config.dataDir, "tdlib");

function chatId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error("invalid chat id");
  return id;
}

export function createTelegramAdapter(accountId: string): TelegramAdapter {
  if (!config.telegramApiId || !config.telegramApiHash) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
  if (!config.sessionEncryptionKey) throw new Error("SESSION_ENCRYPTION_KEY is required before login");
  const directory = join(sessionRoot, createHash("sha256").update(accountId).digest("hex"));
  mkdirSync(directory, { recursive: true });
  let client: Client | null = null;
  let userId = 0;
  let authReadyDone = false;
  let previouslyAuthorized = false;
  let authError: Error | null = null;
  let authPhase: AuthType | "ready" | "closed" = "phone";
  let phaseVersion = 0;
  const authWaiters = new Map<AuthType, { resolve(value: string): void; reject(error: Error): void }>();
  const authInputs = new Map<AuthType, string>();
  const authRequests: Record<AuthType, number> = { phone: 0, code: 0, password: 0 };
  const phaseWaiters: Array<{ phases: Array<AuthType | "ready" | "closed">; resolve(): void }> = [];
  let authReadyResolve!: () => void;
  let authReadyReject!: (error: Error) => void;
  const authReady = new Promise<void>((resolve, reject) => { authReadyResolve = resolve; authReadyReject = reject; });
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
    if (update._ === "updateAuthorizationState") {
      const state = update.authorization_state;
      if (state._ === "authorizationStateWaitPhoneNumber") setPhase("phone");
      if (state._ === "authorizationStateWaitCode") setPhase("code");
      if (state._ === "authorizationStateWaitPassword") setPhase("password");
      if (state._ === "authorizationStateClosed") setPhase("closed");
      if (state._ === "authorizationStateReady") {
        setPhase("ready");
        previouslyAuthorized = true;
        void td.invoke({ _: "getMe" }).then((me) => { userId = me.id; authReadyDone = true; authReadyResolve(); }).catch(authReadyReject);
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
      if (authPhase === "password") {
        if (!password) throw new Error("SESSION_PASSWORD_NEEDED");
        const request = authRequests.password;
        provide("password", password);
        while (authRequests.password === request && !["ready", "closed"].includes(currentPhase())) await new Promise((resolve) => setTimeout(resolve, 50));
        if (authRequests.password > request) throw new Error("PASSWORD_HASH_INVALID");
      } else if (authPhase === "code") {
        const request = authRequests.code;
        provide("code", code);
        while (authRequests.code === request && !["ready", "password", "closed"].includes(currentPhase())) await new Promise((resolve) => setTimeout(resolve, 50));
        if (authError) throw authError;
        if (authRequests.code > request) throw new Error("PHONE_CODE_INVALID");
        if (currentPhase() === "password") throw new Error("SESSION_PASSWORD_NEEDED");
      } else throw new Error("Telegram is not waiting for a login code");
      if (currentPhase() === "closed") throw new Error("Telegram closed the login session");
      await ready();
      return { session: `tdlib:${accountId}`, userId };
    },
    async dialogs() {
      const current = await ready();
      const chats = await current.invoke({ _: "getChats", chat_list: { _: "chatListMain" }, limit: 200 });
      const result: TelegramDialog[] = [];
      for (const id of chats.chat_ids) {
        const chat = await current.invoke({ _: "getChat", chat_id: id }) as TdChat;
        if (chat.type._ !== "chatTypeBasicGroup" && chat.type._ !== "chatTypeSupergroup") continue;
        result.push({ chatId: String(chat.id), title: chat.title, username: null });
      }
      return result;
    },
    async canPost(target) {
      const current = await ready(), id = chatId(target), chat = await current.invoke({ _: "getChat", chat_id: id });
      if (chat.type._ === "chatTypeSupergroup" && chat.type.is_channel) {
        const me = await current.invoke({ _: "getMe" });
        const member = await current.invoke({ _: "getChatMember", chat_id: id, member_id: { _: "messageSenderUser", user_id: me.id } });
        if (member.status._ === "chatMemberStatusCreator") return true;
        return member.status._ === "chatMemberStatusAdministrator" && member.status.rights.can_post_messages;
      }
      return chat.permissions.can_send_basic_messages;
    },
    async sendMessage(target, message, entities) {
      const current = await ready();
      const formatted = entities?.length ? { _: "formattedText" as const, text: message, entities: entities as Td.textEntity[] } : { _: "formattedText" as const, text: message, entities: [] };
      await current.invoke({ _: "sendMessage", chat_id: chatId(target), input_message_content: { _: "inputMessageText", text: formatted, clear_draft: false } });
    },
    async copyMessage(target, sourceChat, messageId) {
      const current = await ready();
      const copied = await current.invoke({ _: "forwardMessages", chat_id: chatId(target), from_chat_id: chatId(sourceChat), message_ids: [messageId], send_copy: true, remove_caption: false });
      if (!copied.messages[0]) throw new Error("Telegram could not copy this message");
    },
    async sendInline(target, query) {
      const current = await ready();
      const bot = await current.invoke({ _: "searchPublicChat", username: config.botUsername });
      const results = await current.invoke({ _: "getInlineQueryResults", bot_user_id: bot.id, chat_id: chatId(target), query, offset: "" });
      const result = results.results[0];
      if (!result) throw new Error("inline campaign result unavailable");
      await current.invoke({ _: "sendInlineQueryResultMessage", chat_id: chatId(target), query_id: results.inline_query_id, result_id: result.id, hide_via_bot: false });
    },
    async logout() {
      const current = client;
      for (const waiter of authWaiters.values()) waiter.reject(new Error("login cancelled"));
      authWaiters.clear();
      for (const type of ["phone", "code", "password"] as const) authInputs.delete(type);
      for (const waiter of phaseWaiters.splice(0)) waiter.resolve();
      setPhase("closed");
      if (!current || current.isClosed()) { client = null; return; }
      try {
        if (authReadyDone) await current.invoke({ _: "logOut" });
      } finally { await current.close(); client = null; rmSync(directory, { recursive: true, force: true }); }
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
