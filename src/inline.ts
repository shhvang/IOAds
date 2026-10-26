import type { InlineQueryResult, InputTextMessageContent, RichMessage } from "grammy/types";
import type Database from "better-sqlite3";

type CachedMedia = Extract<InlineQueryResult, { type: "photo" | "video" | "document" | "gif" | "mpeg4_gif" | "audio" | "voice" | "sticker" }>;
type InlineRichMessage = Extract<Extract<InlineQueryResult, { type: "article" }>["input_message_content"], { rich_message: unknown }>["rich_message"];
export type InlineCampaign = { id: number; name: string; message: string; messageEntities: string; richMessage: string | null; richContent: string | null; inlineOptions: string | null; contentKind: string };
export const IOADS_LOGO_EMOJI_ID = "6269269392949782410";

function attributionMarkup(original: Extract<InlineQueryResult, { type: "article" }>["reply_markup"], botUsername: string) {
  const username = botUsername.replace(/^@/, "");
  const attribution = { text: "posted by IOAds", icon_custom_emoji_id: IOADS_LOGO_EMOJI_ID, url: `https://t.me/${username}?start=posted` };
  return { inline_keyboard: [...(original?.inline_keyboard ?? []), [attribution]] };
}

/** Telegram may reject custom emoji icons if the bot lacks a Fragment username. */
export function withoutAttributionIcons(results: InlineQueryResult[]): InlineQueryResult[] {
  return results.map((result) => {
    if (!("reply_markup" in result) || !result.reply_markup) return result;
    return { ...result, reply_markup: { ...result.reply_markup, inline_keyboard: result.reply_markup.inline_keyboard.map((row) => row.map((button) => {
      if (button.icon_custom_emoji_id !== IOADS_LOGO_EMOJI_ID || !["posted by IOAds", "Open IOAds"].includes(button.text)) return button;
      const { icon_custom_emoji_id: _icon, ...plain } = button;
      return plain;
    })) } } as InlineQueryResult;
  });
}

// Received rich blocks contain output media objects; inline results require input media objects.
export function reusableRichMessage(message: RichMessage): InlineRichMessage {
  const reusableButton = (value: unknown): boolean => !!value && typeof value === "object" &&
    ("url" in value || "copy_text" in value || "disabled" in value);
  function checkButtons(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(checkButtons); return; }
    const item = value as Record<string, unknown>;
    if (item.type === "buttons" && Array.isArray(item.buttons) && !item.buttons.every(reusableButton))
      throw new Error("This rich post contains buttons tied to another bot. Use URL or copy buttons instead.");
    if (item.type === "button" && !reusableButton(item.button))
      throw new Error("This rich post contains a button tied to another bot. Use a URL or copy button instead.");
    for (const child of Object.values(item)) checkButtons(child);
  }
  checkButtons(message);
  function block(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object") throw new Error("Invalid rich message block");
    const result = { ...value } as Record<string, unknown>;
    if (typeof result.type !== "string") throw new Error("Invalid rich message block type");
    if (Array.isArray(result.blocks)) result.blocks = result.blocks.map(block);
    if (Array.isArray(result.items)) result.items = result.items.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Invalid rich list item");
      const copy = { ...item } as Record<string, unknown>;
      if (Array.isArray(copy.blocks)) copy.blocks = copy.blocks.map(block);
      return copy;
    });
    const mediaField: Record<string, string> = { animation: "animation", audio: "audio", document: "document", photo: "photo", video: "video", voice_note: "voice_note" };
    const field = mediaField[result.type];
    if (field) {
      const source = result[field];
      const file = Array.isArray(source) ? source.at(-1) : source;
      const fileId = file && typeof file === "object" ? (file as { file_id?: unknown }).file_id : undefined;
      if (typeof fileId !== "string" || !fileId) throw new Error(`Rich ${result.type} has no reusable file`);
      result[field] = { type: result.type === "voice_note" ? "voice_note" : result.type, media: fileId };
    }
    return result;
  }
  return { blocks: message.blocks.map(block) as unknown as InlineRichMessage["blocks"], ...(message.is_rtl ? { is_rtl: true } : {}) };
}

export function campaignInlineResult(campaign: InlineCampaign, botUsername: string): InlineQueryResult {
  const options = campaign.inlineOptions ? JSON.parse(campaign.inlineOptions) as {
    reply_markup?: Extract<InlineQueryResult, { type: "article" }>["reply_markup"];
    link_preview_options?: InputTextMessageContent["link_preview_options"];
  } : {};
  const reply_markup = attributionMarkup(options.reply_markup, botUsername);
  if (campaign.richContent) {
    return { type: "article", id: String(campaign.id), title: campaign.name,
      description: campaign.message.slice(0, 100), input_message_content: { rich_message: JSON.parse(campaign.richContent) as InlineRichMessage }, reply_markup };
  }
  if (campaign.richMessage) {
    const media = JSON.parse(campaign.richMessage) as Omit<CachedMedia, "id">;
    return { ...media, id: String(campaign.id), reply_markup } as InlineQueryResult;
  }
  return { type: "article", id: String(campaign.id), title: campaign.name,
    description: campaign.message.slice(0, 100), input_message_content: { message_text: campaign.message, entities: JSON.parse(campaign.messageEntities), link_preview_options: options.link_preview_options }, reply_markup };
}

export function featureInlineResult(botUsername: string): InlineQueryResult {
  const url = `https://t.me/${botUsername.replace(/^@/, "")}?start=inline`;
  return { type: "article", id: "ioads-features", title: "IOAds · scheduled Telegram posts",
    description: "Connect accounts, choose groups, and schedule posts. Open the bot to get started.",
    input_message_content: { message_text: "IOAds schedules posts to groups your connected Telegram accounts already belong to. Choose the groups and timing in the bot." },
    reply_markup: { inline_keyboard: [[{ text: "Open IOAds", icon_custom_emoji_id: IOADS_LOGO_EMOJI_ID, url }]] } };
}

export function inlineResults(db: Database.Database, userId: number, query: string, botUsername: string): InlineQueryResult[] {
  const campaignId = /^campaign:(\d+)$/.exec(query)?.[1];
  if (!campaignId) return botUsername ? [featureInlineResult(botUsername)] : [];
  if (!botUsername) return [];
  const user = db.prepare("SELECT tenantId FROM localUsers WHERE telegramId = ? AND forceJoined = 1").get(userId) as { tenantId: string } | undefined;
  const campaign = db.prepare(`SELECT c.id, c.name, c.message, c.messageEntities, c.richMessage, c.richContent, c.inlineOptions, c.contentKind FROM campaigns c
    WHERE c.id = ? AND ((? IS NOT NULL AND c.tenantId = ?) OR EXISTS (SELECT 1 FROM campaignTargets ct JOIN accounts a ON a.tenantId=ct.tenantId AND a.accountId=ct.accountId WHERE ct.campaignId=c.id AND ct.tenantId=c.tenantId AND a.telegramUserId = ? AND a.status='active' AND a.session IS NOT NULL))`)
    .get(Number(campaignId), user?.tenantId ?? null, user?.tenantId ?? null, userId) as InlineCampaign | undefined;
  if (!campaign || ((campaign.contentKind === "media" || campaign.contentKind === "rich") && !campaign.richContent && !campaign.richMessage)
    || (campaign.contentKind === "legacy" && campaign.message === "[Telegram media or rich message]")) return [];
  if (campaign.inlineOptions && (JSON.parse(campaign.inlineOptions) as { has_media_spoiler?: boolean }).has_media_spoiler) return [];
  return [campaignInlineResult(campaign, botUsername)];
}
