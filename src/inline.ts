import type { InlineQueryResult, InputTextMessageContent, MessageEntity, RichMessage, RichText } from "grammy/types";
import type Database from "better-sqlite3";

type CachedMedia = Extract<InlineQueryResult, { type: "photo" | "video" | "document" | "gif" | "mpeg4_gif" | "audio" | "voice" | "sticker" }>;
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type CachedMediaWithoutId = WithoutId<CachedMedia>;
type InlineRichMessage = Extract<Extract<InlineQueryResult, { type: "article" }>["input_message_content"], { rich_message: unknown }>["rich_message"];
export type InlineCampaign = { id: number; name: string; message: string; messageEntities: string; richMessage: string | null; richContent: string | null; inlineOptions: string | null; contentKind: string };
function attributionBlock(botUsername: string) {
  return { type: "buttons" as const, align: "right" as const, buttons: [{
    text: "posted by IOAds",
    url: `https://t.me/${botUsername.replace(/^@/, "")}?start=posted`,
  }] };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

type EntityNode = { entity: MessageEntity; end: number; children: EntityNode[] };
function entityTree(text: string, entities: MessageEntity[]): EntityNode[] {
  const roots: EntityNode[] = [], stack: EntityNode[] = [];
  for (const entity of [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length)) {
    const end = entity.offset + entity.length;
    if (entity.offset < 0 || entity.length <= 0 || end > text.length) throw new Error("Invalid post formatting offsets");
    while (stack.length && entity.offset >= stack.at(-1)!.end) stack.pop();
    if (stack.length && end > stack.at(-1)!.end) throw new Error("Overlapping post formatting cannot be reproduced");
    const siblings = stack.at(-1)?.children ?? roots;
    siblings.push({ entity, end, children: [] });
    stack.push(siblings.at(-1)!);
  }
  return roots;
}

export function textWithEntitiesHtml(text: string, entities: MessageEntity[]): string {
  const render = (nodes: EntityNode[], start: number, end: number, inPre = false): string => {
    let output = "", cursor = start;
    const plain = (from: number, to: number) => escapeHtml(text.slice(from, to)).replace(/\n/g, inPre ? "\n" : "<br>");
    for (const node of nodes) {
      const { entity } = node;
      output += plain(cursor, entity.offset);
      const inner = render(node.children, entity.offset, node.end, inPre || entity.type === "pre");
      const attr = (value: unknown) => escapeHtml(String(value));
      switch (entity.type) {
        case "bold": output += `<b>${inner}</b>`; break;
        case "italic": output += `<i>${inner}</i>`; break;
        case "underline": output += `<u>${inner}</u>`; break;
        case "strikethrough": output += `<s>${inner}</s>`; break;
        case "spoiler": output += `<tg-spoiler>${inner}</tg-spoiler>`; break;
        case "code": output += `<code>${inner}</code>`; break;
        case "pre": output += `<pre><code${entity.language ? ` class="language-${attr(entity.language)}"` : ""}>${inner}</code></pre>`; break;
        case "blockquote": output += `<blockquote>${inner}</blockquote>`; break;
        case "expandable_blockquote": output += `<blockquote expandable>${inner}</blockquote>`; break;
        case "text_link": output += `<a href="${attr(entity.url)}">${inner}</a>`; break;
        case "text_mention": output += `<a href="tg://user?id=${attr(entity.user.id)}">${inner}</a>`; break;
        case "url": output += `<a href="${attr(text.slice(entity.offset, node.end))}">${inner}</a>`; break;
        case "email": output += `<a href="mailto:${attr(text.slice(entity.offset, node.end))}">${inner}</a>`; break;
        case "phone_number": output += `<a href="tel:${attr(text.slice(entity.offset, node.end))}">${inner}</a>`; break;
        case "custom_emoji": output += `<tg-emoji emoji-id="${attr(entity.custom_emoji_id)}">${inner}</tg-emoji>`; break;
        case "date_time": output += `<tg-time unix="${attr(entity.unix_time)}"${entity.date_time_format ? ` format="${attr(entity.date_time_format)}"` : ""}>${inner}</tg-time>`; break;
        case "mention": case "hashtag": case "cashtag": case "bot_command": output += inner; break;
        default: throw new Error(`Unsupported post formatting: ${(entity as MessageEntity).type}`);
      }
      cursor = node.end;
    }
    return output + plain(cursor, end);
  };
  return render(entityTree(text, entities), 0, text.length);
}

function richTextFromEntities(text: string, entities: MessageEntity[]): RichText {
  const render = (nodes: EntityNode[], start: number, end: number): RichText => {
    const parts: RichText[] = [];
    let cursor = start;
    for (const node of nodes) {
      const { entity } = node;
      if (cursor < entity.offset) parts.push(text.slice(cursor, entity.offset));
      const inner = render(node.children, entity.offset, node.end);
      const slice = text.slice(entity.offset, node.end);
      switch (entity.type) {
        case "custom_emoji": parts.push({ type: "custom_emoji", custom_emoji_id: entity.custom_emoji_id, alternative_text: slice }); break;
        case "text_link": parts.push({ type: "url", text: inner, url: entity.url }); break;
        case "url": parts.push({ type: "url", text: inner, url: slice }); break;
        case "text_mention": parts.push({ type: "text_mention", text: inner, user: entity.user }); break;
        case "bold": case "italic": case "underline": case "strikethrough": case "spoiler": case "code": parts.push({ type: entity.type, text: inner }); break;
        case "email": parts.push({ type: "email_address", text: inner, email_address: slice }); break;
        case "phone_number": parts.push({ type: "phone_number", text: inner, phone_number: slice }); break;
        case "mention": parts.push({ type: "mention", text: inner, username: slice.replace(/^@/, "") }); break;
        case "hashtag": parts.push({ type: "hashtag", text: inner, hashtag: slice }); break;
        case "cashtag": parts.push({ type: "cashtag", text: inner, cashtag: slice }); break;
        case "bot_command": parts.push({ type: "bot_command", text: inner, bot_command: slice }); break;
        case "date_time": parts.push({ type: "date_time", text: inner, unix_time: entity.unix_time, date_time_format: entity.date_time_format as "r" }); break;
        default: throw new Error(`Unsupported caption formatting: ${entity.type}`);
      }
      cursor = node.end;
    }
    if (cursor < end) parts.push(text.slice(cursor, end));
    return parts.length === 1 ? parts[0]! : parts;
  };
  return render(entityTree(text, entities), 0, text.length);
}

function attributionHtml(botUsername: string): string {
  const url = escapeHtml(`https://t.me/${botUsername.replace(/^@/, "")}?start=posted`);
  return `<tg-button-row align="right"><tg-button type="url" url="${url}">posted by IOAds</tg-button></tg-button-row>`;
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

function richMediaBlock(media: CachedMediaWithoutId): NonNullable<InlineRichMessage["blocks"]>[number] | null {
  if ("show_caption_above_media" in media && media.show_caption_above_media) return null;
  const caption = "caption" in media && media.caption
    ? { text: richTextFromEntities(media.caption, (media.caption_entities ?? []) as MessageEntity[]) } : undefined;
  switch (media.type) {
    case "photo": return "photo_file_id" in media ? { type: "photo", photo: { type: "photo", media: media.photo_file_id }, caption } : null;
    case "video": return "video_file_id" in media ? { type: "video", video: { type: "video", media: media.video_file_id }, caption } : null;
    case "document": return "document_file_id" in media ? { type: "document", document: { type: "document", media: media.document_file_id }, caption } : null;
    case "gif": return "gif_file_id" in media ? { type: "animation", animation: { type: "animation", media: media.gif_file_id }, caption } : null;
    case "mpeg4_gif": return "mpeg4_file_id" in media ? { type: "animation", animation: { type: "animation", media: media.mpeg4_file_id }, caption } : null;
    case "audio": return "audio_file_id" in media ? { type: "audio", audio: { type: "audio", media: media.audio_file_id }, caption } : null;
    case "voice": return "voice_file_id" in media ? { type: "voice_note", voice_note: { type: "voice_note", media: media.voice_file_id }, caption } : null;
    case "sticker": return null;
  }
}

export function campaignInlineResult(campaign: InlineCampaign, botUsername: string): InlineQueryResult {
  const options = campaign.inlineOptions ? JSON.parse(campaign.inlineOptions) as {
    reply_markup?: Extract<InlineQueryResult, { type: "article" }>["reply_markup"];
    link_preview_options?: InputTextMessageContent["link_preview_options"];
  } : {};
  const reply_markup = options.reply_markup;
  if (campaign.richContent) {
    const original = JSON.parse(campaign.richContent) as InlineRichMessage;
    return { type: "article", id: String(campaign.id), title: campaign.name,
      description: campaign.message.slice(0, 100), input_message_content: { rich_message: { ...original, blocks: [...(original.blocks ?? []), attributionBlock(botUsername)] } }, reply_markup };
  }
  if (campaign.richMessage) {
    const media = JSON.parse(campaign.richMessage) as CachedMediaWithoutId;
    try {
      const block = richMediaBlock(media);
      if (block) return { type: "article", id: String(campaign.id), title: campaign.name,
        description: campaign.message.slice(0, 100), input_message_content: { rich_message: { blocks: [block, attributionBlock(botUsername)] } }, reply_markup };
    } catch { /* Keep the original cached-media result if its caption cannot be represented as rich content. */ }
    return { ...media, id: String(campaign.id), reply_markup } as InlineQueryResult;
  }
  const entities = JSON.parse(campaign.messageEntities) as MessageEntity[];
  if (!options.link_preview_options) {
    try {
      const content = textWithEntitiesHtml(campaign.message, entities);
      const body = /<(?:pre|blockquote)\b/.test(content) ? content : `<p>${content}</p>`;
      return { type: "article", id: String(campaign.id), title: campaign.name,
        description: campaign.message.slice(0, 100), input_message_content: { rich_message: {
          html: `${body}${attributionHtml(botUsername)}`,
        } }, reply_markup };
    } catch { /* Keep regular text and entities if rich formatting cannot reproduce the source. */ }
  }
  return { type: "article", id: String(campaign.id), title: campaign.name,
    description: campaign.message.slice(0, 100), input_message_content: { message_text: campaign.message, entities, link_preview_options: options.link_preview_options }, reply_markup };
}

export function featureInlineResult(botUsername: string): InlineQueryResult {
  const url = escapeHtml(`https://t.me/${botUsername.replace(/^@/, "")}?start=inline`);
  return { type: "article", id: "ioads-features", title: "IOAds · scheduled Telegram posts",
    description: "Connect accounts, choose groups, and schedule posts. Open the bot to get started.",
    input_message_content: { rich_message: { html: `<p>IOAds schedules posts to groups your connected Telegram accounts already belong to. Choose the groups and timing in the bot.</p><tg-button-row align="right"><tg-button type="url" url="${url}">Open IOAds</tg-button></tg-button-row>` } } };
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
