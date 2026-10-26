// Telegram UI custom emoji IDs shared with the shop service. Keep the fallback
// emoji aligned with each asset so buttons still read clearly without Premium.
export const icons = {
  back: ["5877629862306385808", "◀️"],
  check: ["5985596818912712352", "✅"],
  cross: ["5985346521103604145", "❌"],
  refresh: ["5877410604225924969", "🔄"],
  megaphone: ["5771695636411847302", "📢"],
  people: ["5942877472163892475", "👥"],
  plus: ["5775937998948404844", "➕"],
  trash: ["5879915802815107172", "🗑"],
  warning: ["5879813604068298387", "❗️"],
  prev: ["5877536313623711363", "⬅️"],
  next: ["5875506366050734240", "➡️"],
  chart: ["5994378914636500516", "📈"],
  card: ["5927169041595634481", "💳"],
  support: ["5891169510483823323", "💬"],
} as const;
export type IconName = keyof typeof icons;
