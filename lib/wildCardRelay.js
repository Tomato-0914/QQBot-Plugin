/**
 * 野生号辅助官方机器人发消息
 *
 * 野生号在这个群里（私聊时野生号与对方是好友）时：
 *   - 官方机器人发不了的内容（json / xml / music 卡片、合并转发、戳一戳）改由野生号发送，
 *     其余内容仍由官方机器人发送；野生号发送失败时交回官方机器人（合并转发会被拍平成普通消息）
 *   - 官方机器人整条消息发送失败（被动回复过期、主动消息额度用完等）时，改由野生号发送
 * 静默群也照发：野生号平时静默，只在官方机器人发不了时代发。wild-silence.json 中 assist: false 可关闭。
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { getGroupUin } from "./groupMap.js"
import { getAppid, getMappedUin, isQQUin } from "./uinMap.js"
import { silenceConfig as cfg, isWild, isSilenced } from "./wildSilence.js"

/** 官方机器人发不了、交给野生号发送的消息段（文件官方机器人能发，只在整条失败时交给野生号） */
const WILD_TYPES = new Set(["json", "xml", "music", "node", "poke"])
/** 只有官方机器人能发的消息段：整条交给野生号兜底时去掉 */
const OFFICIAL_ONLY = new Set(["reply", "button", "keyboard", "raw", "ark", "embed", "stream"])

/** 野生号替官方机器人发送期间为 true：野生号静默的拦截要放行，官方机器人这边也不再转交，避免来回转发 */
export const relaying = new AsyncLocalStorage()

const toArray = msg => (Array.isArray(msg) ? msg : [msg])

/** 消息段是否要交给野生号发送 */
export const needsWild = seg => WILD_TYPES.has(seg?.type)

/** 消息段是否有实际内容（引用回复本身不算） */
const hasContent = msg => msg.some(seg => (typeof seg === "object" ? seg?.type !== "reply" : String(seg ?? "") !== ""))

const isSent = ret =>
  !!ret && (Array.isArray(ret.message_id) ? ret.message_id.length > 0 : ret.message_id != null && ret.message_id !== "")

/** 官方机器人的发送结果是否为整条失败（有错误、且没有任何消息发出） */
const isFailed = ret => !!ret?.error?.length && !isSent(ret)

const stripSelf = (adapter, data, id) => String(id).replace(`${data.self_id}${adapter.sep ?? ":"}`, "")

/** 官方机器人发送时的群号转成真实群号，没有群绑定时返回 undefined */
export async function realGroupId(adapter, data) {
  const gid = stripSelf(adapter, data, data.group_id)
  if (/^\d{5,15}$/.test(gid)) return gid
  return (await getGroupUin(data.bot || data.self_id, data._raw_group_id || gid)) || undefined
}

/** 官方机器人的用户 id 转成真实 QQ 号，没有绑定时返回 undefined */
export async function realUserId(botOrId, userId) {
  const uid = String(userId ?? "")
  if (isQQUin(uid)) return uid
  return (await getMappedUin(getAppid(botOrId), uid)) || undefined
}

const inGroup = (bot, gid) => bot?.gl?.has(Number(gid)) || bot?.gl?.has(String(gid))
const wildIds = () => (Bot.uin || []).map(String).filter(isWild)

/** 静默群里、在这个群的野生号 */
export function silencedWild(gid) {
  for (const id of wildIds()) {
    const bot = Bot[id]
    if (!isSilenced(id, gid) || !bot?.pickGroup) continue
    if (bot.gl && !inGroup(bot, gid)) continue
    return bot
  }
}

/** 能替官方机器人在这个群里发消息的野生号：优先静默群里的，其次任意在群里的 */
export function assistWild(gid) {
  return silencedWild(gid) || wildIds().map(id => Bot[id]).find(bot => bot?.pickGroup && inGroup(bot, gid))
}

/** 与这个 QQ 号是好友的野生号 */
export function friendWild(uid) {
  return wildIds()
    .map(id => Bot[id])
    .find(bot => bot?.pickFriend && (bot.fl?.has(Number(uid)) || bot.fl?.has(String(uid))))
}

/** 整条交给野生号时的消息：去掉只有官方机器人能发的部分，Markdown 转成文字，@ 的 openid 换成 QQ 号 */
async function forWild(bot, msg) {
  const out = []
  for (const seg of msg) {
    if (typeof seg !== "object" || !seg) {
      out.push(seg)
      continue
    }
    if (OFFICIAL_ONLY.has(seg.type)) continue
    if (seg.type === "markdown") {
      const text = typeof seg.data === "string" ? seg.data : seg.data?.content ?? seg.text
      if (text) out.push(String(text))
      continue
    }
    if (seg.type === "at" && seg.qq !== "all" && !isQQUin(seg.qq)) {
      const qq = await realUserId(bot, seg.qq)
      if (qq) out.push({ ...seg, qq })
      continue
    }
    out.push(seg)
  }
  return out
}

/** 找到替官方机器人发送的野生号，返回 { send, name, tag }；找不到返回 undefined */
async function target(adapter, data, scope) {
  if (scope === "friend") {
    const uid = await realUserId(data.bot || data.self_id, stripSelf(adapter, data, data.user_id))
    const wild = uid && friendWild(uid)
    if (!wild) return
    return { wild, send: msg => wild.pickFriend(Number(uid)).sendMsg(msg), tag: `[野生号辅助] 好友 ${uid}` }
  }
  const gid = await realGroupId(adapter, data)
  const wild = gid && assistWild(gid)
  if (!wild) return
  return { wild, send: msg => wild.pickGroup(Number(gid)).sendMsg(msg), tag: `[野生号辅助] 群 ${gid}` }
}

/** 包装官方机器人的 sendGroupMsg / sendFriendMsg（scope 为 group / friend） */
export function makeWildRelay(adapter, orig, scope = "group") {
  return async function (data, msg) {
    if (relaying.getStore() || cfg.assist === false) return orig.call(this, data, msg)
    const to = await target(adapter, data, scope)
    if (!to) return orig.call(this, data, msg)
    const who = to.wild.uin || to.wild.self_id || ""
    const wildSend = m => relaying.run(true, () => to.send(m))

    // 1. 官方机器人发不了的部分交给野生号
    const segs = toArray(msg)
    const failed = new Set()
    let wildRet
    for (const seg of segs.filter(needsWild)) {
      try {
        const ret = await wildSend(seg)
        if (!isSent(ret)) throw ret?.error?.[0] || new Error("发送返回为空")
        wildRet ??= ret
        logger.mark(`${to.tag} ${seg.type} 已改由野生号 ${who} 发送`)
      } catch (err) {
        failed.add(seg)
        logger.warn(`${to.tag} 野生号发送 ${seg.type} 失败，改由官方机器人发送：${err?.message || err}`)
      }
    }
    const rest = segs.some(needsWild) ? segs.filter(seg => !needsWild(seg) || failed.has(seg)) : msg
    if (wildRet && !hasContent(toArray(rest))) return wildRet

    // 2. 其余内容由官方机器人发送，整条失败时交给野生号
    let ret
    let error
    try {
      ret = await orig.call(this, data, rest)
      if (!isFailed(ret)) return ret
    } catch (err) {
      error = err
    }
    const fallback = await forWild(data.bot || data.self_id, toArray(rest).filter(seg => !failed.has(seg)))
    if (hasContent(fallback)) {
      try {
        const sent = await wildSend(fallback)
        if (isSent(sent)) {
          logger.mark(`${to.tag} 官方机器人发送失败（${(error || ret?.error?.[0])?.message || "未知错误"}），已改由野生号 ${who} 发送`)
          return sent
        }
      } catch (err) {
        logger.warn(`${to.tag} 官方机器人发送失败后，野生号也发送失败：${err?.message || err}`)
      }
    }
    if (error) throw error
    return ret
  }
}
