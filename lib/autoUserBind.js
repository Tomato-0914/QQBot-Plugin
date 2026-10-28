/**
 * 自动 QQ 绑定：官方机器人和野生号在同一个群时，把同一条群消息两边的发送者对上
 *
 * 官方机器人只拿得到 openid，野生号拿得到 QQ 号，两边的消息 ID 不通用，
 * 改用「同一个群 + 同样的文字 + 时间相近」对应：
 *   1. 官方机器人收到消息后等 WINDOW，前后 WINDOW 内这段文字在官方机器人这边只有一个 openid 发过、
 *      在野生号这边只有一个 QQ 号发过，才算一次匹配（多人同时发“1”“哈哈”之类的直接放弃）
 *   2. 头像校验（同 #QQ绑定）通过才保存；默认头像人人相同，要两段不同的文字都对上同一对才保存
 *   3. 同一个 openid 对上过不同的 QQ 号（或反过来），或 QQ 号已绑定给别的 openid，视为冲突，
 *      不再自动绑定，留给 #QQ绑定
 */
import { checkAvatar } from "./avatarVerify.js"
import { getMappedOpenid, getMappedUin, saveMapping } from "./uinMap.js"

export const WINDOW = 15 * 1000
const KEEP = 60 * 1000 // 消息记录保留时长，需大于 WINDOW 的两倍
const AVATAR_TTL = 60 * 60 * 1000 // 头像校验结果的有效期，未通过的一小时后再试
const MAX_PAIRS = 5000

/** 只取文字部分并去掉空白（两边对 @ 的表示不同），少于 2 个字不参与匹配 */
export function textKey(message) {
  const text = (Array.isArray(message) ? message : [])
    .filter(i => i?.type === "text")
    .map(i => i.text || "")
    .join("")
    .replace(/\s+/g, "")
  return [...text].length >= 2 ? text.slice(0, 200) : ""
}

export function createAutoUserBind({
  now = Date.now,
  schedule = setTimeout,
  check = checkAvatar,
  getUin = getMappedUin,
  getOpenid = getMappedOpenid,
  save = saveMapping,
  log = (...args) => Bot.makeLog?.(...args),
} = {}) {
  const recent = new Map() // 群号 → 最近的消息 [{ side, appid, id, key, at }]
  const pairs = new Map() // appid:openid → { uin, keys, conflict, avatar }
  const owners = new Map() // appid:uin → openid，发现一个 QQ 号对上多个 openid 时判为冲突
  const busy = new Set()

  function push(group, entry) {
    const list = (recent.get(group) || []).filter(e => entry.at - e.at <= KEEP)
    list.push(entry)
    recent.set(group, list)
  }

  /** 前后 WINDOW 内同一段文字：官方机器人这边只有这一个 openid、野生号这边只有一个 QQ 号时返回该 QQ 号 */
  function match(group, entry) {
    const near = (recent.get(group) || []).filter(e => e.key === entry.key && Math.abs(e.at - entry.at) <= WINDOW)
    const openids = new Set(near.filter(e => e.side === "official" && e.appid === entry.appid).map(e => e.id))
    const uins = new Set(near.filter(e => e.side === "wild").map(e => e.id))
    return openids.size === 1 && uins.size === 1 ? [...uins][0] : null
  }

  function conflict(pair, appid, openid, uin) {
    if (!pair.conflict) log("info", [`QQBot 自动绑定冲突，改为手动 #QQ绑定：${openid} ↔ ${uin}`])
    pair.conflict = true
    return false
  }

  async function vote(appid, openid, uin, key) {
    const id = `${appid}:${openid}`
    let pair = pairs.get(id)
    if (pair && pair.uin !== uin) return conflict(pair, appid, openid, uin)
    if (!pair) {
      if (pairs.size >= MAX_PAIRS) {
        pairs.clear()
        owners.clear()
      }
      pair = { uin, keys: new Set(), conflict: false, avatar: null }
      pairs.set(id, pair)
    }
    const owner = owners.get(`${appid}:${uin}`)
    if (owner && owner !== openid) {
      const other = pairs.get(`${appid}:${owner}`)
      if (other) conflict(other, appid, owner, uin)
      return conflict(pair, appid, openid, uin)
    }
    owners.set(`${appid}:${uin}`, openid)
    if (pair.conflict) return false
    pair.keys.add(key)

    if (busy.has(id)) return false
    busy.add(id)
    try {
      if (await getUin(appid, openid)) {
        pairs.delete(id)
        return false
      }
      if (await getOpenid(appid, uin)) return conflict(pair, appid, openid, uin)

      if (!pair.avatar || now() - pair.avatar.at > AVATAR_TTL)
        pair.avatar = { ...(await check(appid, openid, uin)), at: now() }
      if (!pair.avatar.ok || pair.keys.size < (pair.avatar.custom ? 1 : 2)) return false

      if (!(await save(appid, openid, uin))) return false
      pairs.delete(id)
      log("info", [`QQBot 自动绑定成功：${openid} → ${uin}`])
      return true
    } catch (err) {
      log("error", ["QQBot 自动绑定失败", openid, uin, err])
      return false
    } finally {
      busy.delete(id)
    }
  }

  return {
    /** 官方机器人收到未绑定成员的群消息：等两边消息都到齐后再匹配 */
    onOfficial({ appid, group, openid, key }) {
      const entry = { side: "official", appid, id: openid, key, at: now() }
      push(group, entry)
      return new Promise(resolve => {
        schedule(() => {
          const uin = match(group, entry)
          resolve(uin ? vote(appid, openid, uin, key) : false)
        }, WINDOW)
      })
    },
    /** 野生号收到的群消息 */
    onWild({ group, uin, key }) {
      push(group, { side: "wild", id: uin, key, at: now() })
    },
    pairs,
  }
}
