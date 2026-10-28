/**
 * 野生号代办：官方机器人没有的功能交给野生号执行
 *
 * 官方机器人的好友 / 群 / 群成员对象缺少点赞、发文件、查成员资料、改名片等方法，
 * 插件调用时会报“不支持”或“xxx is not a function”。这里给这些对象补上同名方法，
 * 调用时找同群（私聊为好友）的野生号执行，返回野生号的结果；插件照常用官方机器人回复结果。
 * 只补官方机器人没有的方法；getMemberMap 例外：官方机器人只有见过的成员，优先取野生号的完整列表。
 * wild-silence.json 中 assist: false 可关闭。
 */
import { assistWild, friendWild, realGroupId, realUserId } from "./wildCardRelay.js"
import { silenceConfig as cfg, isWild } from "./wildSilence.js"

const FRIEND = ["thumbUp", "sendFile", "sendForwardMsg", "getInfo"]
const MEMBER = ["getInfo", "poke"]
const GROUP = [
  "sendFile",
  "sendForwardMsg",
  "getMemberList",
  "getMemberArray",
  "getMemberMap",
  "getHonorInfo",
  "getEssence",
  "pokeMember",
  "setCard",
  "setTitle",
  "setAdmin",
  "setName",
  "sign",
  "muteAll",
]
/** 第一个参数是群成员 QQ 号的群方法：官方机器人这边可能是 openid，转成 QQ 号再交给野生号 */
const GROUP_USER_ARG = new Set(["pokeMember", "setCard", "setTitle", "setAdmin"])
/** 官方机器人有、但优先用野生号的方法（野生号失败时用回官方机器人的） */
const PREFER_WILD = new Set(["getMemberMap"])

const ASSIST = Symbol("wildAssist")

const anyWild = () =>
  (Bot.uin || []).map(String).filter(isWild).map(id => Bot[id]).find(bot => bot?.pickFriend)

/** 给 obj 补上 names 中缺少的方法，call(name, args) 交给野生号执行 */
function assist(obj, names, call) {
  for (const name of names) {
    const own = obj[name]
    if (typeof own === "function" && !own[ASSIST] && !PREFER_WILD.has(name)) continue
    const fallback = typeof own === "function" && !own[ASSIST] ? own : undefined
    const fn = async (...args) => {
      try {
        return await call(name, args)
      } catch (err) {
        if (fallback) return fallback(...args)
        throw err
      }
    }
    fn[ASSIST] = true
    obj[name] = fn
  }
  return obj
}

async function userOf(botId, userId) {
  const uid = await realUserId(botId, userId)
  if (!uid) throw new Error("对方还没有绑定 QQ 号，无法交给野生号处理")
  return uid
}

async function groupOf(adapter, botId, groupId) {
  const gid = await realGroupId(adapter, { self_id: botId, bot: Bot[botId], group_id: groupId })
  if (!gid) throw new Error("这个群还没有群绑定，无法交给野生号处理")
  const wild = assistWild(gid)
  if (!wild) throw new Error("野生号不在这个群，无法代办")
  return { gid: Number(gid), wild }
}

const isGuild = id => String(id ?? "").startsWith("qg_")

/** 包装官方机器人适配器的 pickFriend / pickMember / pickGroup */
export function installWildAssist(adapter) {
  // 保存最初的方法，热重载时重新包一层，不会越包越多
  const orig = (adapter._wildAssistOrig ??= {
    pickFriend: adapter.pickFriend,
    pickMember: adapter.pickMember,
    pickGroup: adapter.pickGroup,
  })

  adapter.pickFriend = function (id, user_id) {
    const obj = orig.pickFriend.call(this, id, user_id)
    if (cfg.assist === false || isGuild(user_id) || !obj) return obj
    return assist(obj, FRIEND, async (name, args) => {
      const uid = await userOf(id, user_id)
      const wild = friendWild(uid) || anyWild()
      if (!wild) throw new Error("没有在线的野生号可以代办")
      return wild.pickFriend(Number(uid))[name](...args)
    })
  }

  adapter.pickMember = function (id, group_id, user_id) {
    const obj = orig.pickMember.call(this, id, group_id, user_id)
    if (cfg.assist === false || isGuild(group_id) || isGuild(user_id) || !obj) return obj
    // getInfo 要群成员资料，不能用好友对象上补的那个
    return assist(obj, MEMBER, async (name, args) => {
      const [{ gid, wild }, uid] = await Promise.all([groupOf(adapter, id, group_id), userOf(id, user_id)])
      return wild.pickMember(gid, Number(uid))[name](...args)
    })
  }

  adapter.pickGroup = function (id, group_id) {
    const obj = orig.pickGroup.call(this, id, group_id)
    if (cfg.assist === false || isGuild(group_id) || !obj) return obj
    return assist(obj, GROUP, async (name, args) => {
      const { gid, wild } = await groupOf(adapter, id, group_id)
      if (GROUP_USER_ARG.has(name) && args.length) args = [Number(await userOf(id, args[0])), ...args.slice(1)]
      return wild.pickGroup(gid)[name](...args)
    })
  }
}
