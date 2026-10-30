/**
 * raw_message 里的官方 @ 标签换成可读文字
 *
 * QQ 官方事件的 content 里 @ 是 <@openid>（Markdown 消息里是 <qqbot-at-user id="openid" />），
 * 原样放进 raw_message 后，用 raw_message 的插件（如 chatgpt-plugin 的群聊上下文）会看到一串 32 位 openid，
 * 还可能把它当成发消息的人。这里换成“@名字”，和野生号（ICQQ / OneBot）的 raw_message 一样可读：
 * 名字取自事件的 mentions、@ 消息段的 username；没有名字时用绑定的 QQ 号；都没有时写“@群友”。
 * @机器人自己（mentions 里 is_you 为 true）没有名字时用机器人昵称。
 */
import { getAppid, getMappedUin } from "./uinMap.js"

/** 已经是 QQ 号（与 uinMap.isQQUin 相同；不从 uinMap 导入，测试里只 mock 了 uinMap 的部分函数） */
const isQQ = id => /^\d{5,12}$/.test(String(id))

const TAG = /<@!?([\w-]+)>|<qqbot-at-user\s+id="([^"]+)"\s*\/?>|<qqbot-at-everyone\s*\/?>/g

const dataOf = seg => (seg?.data && typeof seg.data === "object" ? seg.data : seg || {})

/**
 * @param {string} raw 原始 raw_message
 * @param {{ bot?: object|string, message?: object[], mentions?: object[] }} context
 *   bot：机器人对象或 id（查绑定的 QQ 号、机器人昵称用）；message：已处理好的消息段；mentions：官方事件的 mentions
 * @returns {Promise<string>}
 */
export async function readableRaw (raw, { bot, message = [], mentions = [] } = {}) {
  const text = String(raw ?? "")
  if (!text.includes("<@") && !text.includes("<qqbot-at-")) return raw

  const botObj = typeof bot === "object" ? bot : globalThis.Bot?.[bot]
  const names = new Map()
  const remember = (id, name) => {
    if (id && name && !names.get(String(id))) names.set(String(id), String(name))
  }
  for (const m of Array.isArray(mentions) ? mentions : []) {
    const id = m?.id || m?.member_openid || m?.user_openid
    const isYou = m?.is_you === true || m?.is_you === "true"
    remember(id, m?.username || m?.nickname || (isYou ? botObj?.nickname || botObj?.info?.username : ""))
  }
  for (const seg of Array.isArray(message) ? message : []) {
    if (seg?.type !== "at") continue
    const d = dataOf(seg)
    for (const id of [d._raw_user_id, d.user_openid, d.user_id, d.qq]) remember(id, d.username || d.name || d.nickname)
  }

  const appid = getAppid(botObj || bot)
  const labels = new Map()
  for (const [, a, b] of text.matchAll(TAG)) {
    const id = a || b
    if (!id || labels.has(id)) continue
    const qq = isQQ(id) ? id : await getMappedUin(appid, id)
    labels.set(id, `@${names.get(id) || qq || "群友"}`)
  }
  return text.replace(TAG, (_, a, b) => (a || b ? labels.get(a || b) : "@全体成员"))
}
