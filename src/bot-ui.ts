import type { Context } from "grammy";
import type { RichMessageButton } from "grammy/types";
import { icons, type IconName } from "./bot-icons.js";

export type Button = RichMessageButton & { icon?: IconName };
export type ButtonRows = Button[][];

export function button(text: string, callback_data: string, style?: "primary" | "success" | "danger" | "link", icon?: IconName): Button {
  return { text, callback_data, ...(style ? { style } : {}), ...(icon ? { icon } : {}) };
}

export function back(to: string, label = "Back"): Button { return button(label, to, "link", "back"); }

export function menu(rows: ButtonRows): ButtonRows { return rows; }

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

type Options = { reply_markup?: ButtonRows; parse_mode?: "HTML" };

/** Build a native Rich Message. The UI's rows live in the message body, never in reply_markup. */
export function richHtml(content: string, rows: ButtonRows = [], isHtml = false): string {
  if (!isHtml) content = escapeHtml(content);
  const raw = /^<(?:h[1-6]|p|table|ul|ol|details|blockquote|hr|footer)\b/.test(content.trim());
  const parts = content.trim().split(/\n\s*\n/);
  const first = parts.shift() ?? "";
  const title = /^(?:[^\n]*?)<b>([^<]+)<\/b>(?:\n|$)/.exec(first);
  const sections = title
    ? [`<h2>${title[1]}</h2>`, first.replace(title[0], "").trim()]
    : [first];
  sections.push(...parts);
  const body = raw ? content.trim() : sections.filter(Boolean).map((part) => part.startsWith("<h2>") ? part : `<p>${part.replace(/\n/g, "<br/>")}</p>`).join("");
  const controls = rows.filter((row) => row.length).map((row) => {
    const buttons = row.map((item) => {
      const style = item.style ? ` style="${item.style}"` : "";
      const icon = item.icon ? `<tg-emoji emoji-id="${icons[item.icon][0]}">${icons[item.icon][1]}</tg-emoji> ` : "";
      if ("callback_data" in item) return `<tg-button type="callback_data" data="${escapeHtml(item.callback_data)}"${style}>${icon}${escapeHtml(item.text)}</tg-button>`;
      if ("url" in item) return `<tg-button type="url" url="${escapeHtml(item.url)}"${style}>${icon}${escapeHtml(item.text)}</tg-button>`;
      throw new Error("Unsupported rich button");
    }).join("");
    return `<tg-button-row>${buttons}</tg-button-row>`;
  }).join("");
  return body + controls;
}

export async function replyRich(ctx: Context, content: string, options: Options = {}) {
  if (!ctx.chat) throw new Error("Chat unavailable");
  return ctx.api.raw.sendRichMessage({ chat_id: ctx.chat.id, rich_message: { html: richHtml(content, options.reply_markup, options.parse_mode === "HTML") } });
}

export async function editRichAt(ctx: Context, messageId: number, content: string, options: Options = {}) {
  if (!ctx.chat) throw new Error("Chat unavailable");
  return ctx.api.raw.editMessageText({ chat_id: ctx.chat.id, message_id: messageId, rich_message: { html: richHtml(content, options.reply_markup, options.parse_mode === "HTML") } });
}

export async function editRich(ctx: Context, content: string, options: Options = {}) {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!messageId) return replyRich(ctx, content, options);
  try {
    return await editRichAt(ctx, messageId, content, options);
  } catch (error) {
    // A callback on an older photo dashboard cannot be turned into a rich text message.
    if (/there is no text|message is not a text message|message can't be edited/i.test(String(error)))
      return replyRich(ctx, content, options);
    throw error;
  }
}
