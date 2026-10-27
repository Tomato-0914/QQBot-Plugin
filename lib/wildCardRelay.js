/**
 * 野生号静默：官方机器人发不了的卡片交给野生号
 *
 * 静默群里，官方机器人要发的消息带有 json / xml / music 卡片（或合并转发里带卡片）时，
 * 卡片改由同群的野生号发送，其余内容仍由官方机器人发送；野生号发送失败时卡片照旧交给官方机器人。
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { getGroupUin } from "./groupMap.js"
import { silenceConfig as cfg, isWild, isSilenced } from "./wildSilence.js"

const CARD = new Set(["json", "xml", "music"])

/** 野生号替官方机器人发卡片期间为 true：野生号静默的拦截要放行，官方机器人这边也不再转交，避免来回转发 */
export const relaying = new AsyncLocalStorage()

/** 消息段是否为卡片（合并转发里任意一条消息带卡片也算） */
export function isCard(seg) {
  if (CARD.has(seg?.type)) return true
  return seg?.type === "node" && (Array.isArray(seg.data) ? seg.data : []).some(node => hasCard(node?.message))
}

export const hasCard = msg => (Array.isArray(msg) ? msg : [msg]).some(isCard)

/** 消息段是否有实际内容（引用回复本身不算） */
const hasContent = msg => msg.some(seg => (typeof seg === "object" ? seg?.type !== "reply" : String(seg ?? "") !== ""))

const isSent = ret =>
  !!ret && (Array.isArray(ret.message_id) ? ret.message_id.length > 0 : ret.message_id != null && ret.message_id !== "")

/** 官方机器人发送时的群号转成真实群号，没有群绑定时返回 undefined */
export async function realGroupId(adapter, data) {
  const gid = String(data.group_id).replace(`${data.self_id}${adapter.sep ?? ":"}`, "")
  if (/^\d{5,15}$/.test(gid)) return gid
  return (await getGroupUin(data.bot || data.self_id, data._raw_group_id || gid)) || undefined
}

/** 静默群里、在这个群的野生号 */
export function wildBotOf(gid) {
  for (const id of (Bot.uin || []).map(String)) {
    if (!isWild(id) || !isSilenced(id, gid)) continue
    const bot = Bot[id]
    if (!bot?.pickGroup) continue
    if (bot.gl && !bot.gl.has(Number(gid)) && !bot.gl.has(String(gid))) continue
    return bot
  }
}

/** 包装官方机器人的 sendGroupMsg：卡片交给野生号，其余照旧 */
export function makeCardRelay(adapter, orig) {
  return async function (data, msg) {
    if (relaying.getStore() || !cfg.enable || !hasCard(msg)) return orig.call(this, data, msg)

    const gid = await realGroupId(adapter, data)
    const wild = gid && wildBotOf(gid)
    if (!wild) return orig.call(this, data, msg)

    const tag = `[野生号静默] 群 ${gid}`
    const segs = Array.isArray(msg) ? msg : [msg]
    const failed = new Set()
    let wildRet
    for (const seg of segs.filter(isCard)) {
      try {
        const ret = await relaying.run(true, () => wild.pickGroup(Number(gid)).sendMsg(seg))
        if (!isSent(ret)) throw ret?.error?.[0] || new Error("发送返回为空")
        wildRet ??= ret
        logger.mark(`${tag} 卡片已改由野生号 ${wild.uin || wild.self_id || ""} 发送`)
      } catch (err) {
        failed.add(seg)
        logger.warn(`${tag} 野生号发送卡片失败，改由官方机器人发送：${err?.message || err}`)
      }
    }

    const rest = segs.filter(seg => !isCard(seg) || failed.has(seg))
    if (wildRet && !hasContent(rest)) return wildRet
    return orig.call(this, data, rest)
  }
}
