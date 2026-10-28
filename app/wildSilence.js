/**
 * 野生号静默
 *
 * 白名单群里，野生号（OneBotv11 / ICQQ）不处理任何消息、不主动发言，全部交给官方机器人：
 *   - 收到的消息：在 loader.deal 入口直接丢弃，不进入任何插件（accept / 规则拦截作为兜底）；
 *     卡片消息例外，由野生号解析、官方机器人发送结果，官方机器人收到的同一张卡片跳过
 *   - 定时任务 / 主动推送：接管野生号的群消息发送，按配置改由官方机器人发、照发或丢弃
 *   - 官方机器人发不了的内容（卡片、合并转发、戳一戳）、整条发送失败的消息：改由野生号发送
 *     （lib/wildCardRelay.js）；官方机器人没有的功能（点赞、查成员资料、改名片等）交给野生号执行
 *     （lib/wildAssist.js）。这两项不限静默群，野生号在群里就会辅助
 */
import { AsyncLocalStorage } from "node:async_hooks"
import plugin from "../../../lib/plugins/plugin.js"
import loader from "../../../lib/plugins/loader.js"
import { translateGroupToOpenid } from "../lib/groupMap.js"
import {
  silenceConfig as cfg,
  saveSilenceConfig as save,
  isWild,
  isSilenced,
  officialId,
} from "../lib/wildSilence.js"
import { relaying, makeWildRelay, silencedWild } from "../lib/wildCardRelay.js"
import { installWildAssist } from "../lib/wildAssist.js"

/** 野生号在静默群里解析卡片期间为 true：它发出的消息不看定时消息配置，始终先交给官方机器人 */
const cardParsing = new AsyncLocalStorage()

const CRON_NAME = { official: "改由官方机器人发", wild: "野生号照发", block: "不发" }

// 官方机器人发不了的消息类型（戳一戳、卡片、合并转发），野生号直接发
const WILD_ONLY = new Set(["poke", "json", "xml", "music", "node"])
const wildOnly = msg => (Array.isArray(msg) ? msg : [msg]).some(s => WILD_ONLY.has(s?.type))

/* ---------- 接管野生号的群消息发送（定时任务、主动推送都走这里） ---------- */

// force：卡片解析结果，不看定时消息配置，始终先交给官方机器人
async function sendSilenced(orig, self, fn, data, msg, force = false) {
  const tag = `[野生号静默] 群 ${data.group_id}`
  const kind = force ? "卡片解析结果" : "主动消息"
  if (!force && cfg.cron === "wild") return orig.call(self, data, msg)
  if (!force && cfg.cron === "block") {
    logger.mark(`${tag} 已拦截野生号的主动消息`)
    return { message_id: [], error: [] }
  }
  if (fn === "sendGroupForwardMsg" || wildOnly(msg)) return orig.call(self, data, msg)

  const id = officialId()
  const bot = id && Bot[id]
  if (!bot?.pickGroup) {
    logger.warn(`${tag} 官方机器人不在线，改由野生号发送`)
    return orig.call(self, data, msg)
  }
  if (!(await translateGroupToOpenid(bot, data.group_id))) {
    logger.warn(`${tag} 官方机器人还没绑定这个群（私聊野生号 #一键群绑定），改由野生号发送`)
    return orig.call(self, data, msg)
  }

  // 引用指向野生号自己的消息 ID，官方机器人无法引用（返回 40011000 请求数据异常），去掉后作为普通消息发送
  const parts = (Array.isArray(msg) ? msg : [msg]).filter(s => s?.type !== "reply")
  if (!parts.length) return orig.call(self, data, msg)

  try {
    const ret = await bot.pickGroup(String(data.group_id)).sendMsg(parts)
    if (ret?.error?.length && !ret.message_id?.length) throw ret.error[0]
    logger.mark(`${tag} ${kind}已改由官方机器人发送`)
    return ret
  } catch (err) {
    logger.warn(`${tag} 官方机器人发送失败，改由野生号发送：${err?.message || err}`)
    return orig.call(self, data, msg)
  }
}

function hookAdapter() {
  const adapter = Bot.adapter?.find(a => a.name === "OneBotv11")
  if (!adapter) return false
  // 保存最初的发送函数，热重载时重新包一层，不会越包越多
  adapter._wildSilenceOrig ??= {
    sendGroupMsg: adapter.sendGroupMsg,
    sendGroupForwardMsg: adapter.sendGroupForwardMsg,
  }
  for (const [fn, orig] of Object.entries(adapter._wildSilenceOrig)) {
    adapter[fn] = function (data, msg) {
      // 替官方机器人发卡片时不拦截
      if (relaying.getStore()) return orig.call(this, data, msg)
      if (isSilenced(data.self_id, data.group_id))
        return sendSilenced(orig, this, fn, data, msg, !!cardParsing.getStore())
      return orig.call(this, data, msg)
    }
  }
  logger.mark("[野生号静默] 已接管野生号的群消息发送")
  return true
}

/* ---------- 收到的消息：静默群里野生号的消息不进入任何插件 ---------- */

// 只靠本插件的 accept / 规则拦截不够：其他插件的 accept 照样执行，
// 优先级数值比本插件更小的规则也会先于拦截规则执行。它们的回复虽然被作废，
// 但命令本身已经跑了，表现为野生号没说话、却给消息点了表情或抢先开始更新，
// 官方机器人随后处理同一条命令时只能回“已经在更新中”。
// 因此直接在 loader.deal 入口丢弃，也不会设置冷却挡住官方机器人随后收到的同一条命令。
//
// 卡片消息例外：QQ 下发给官方机器人的小程序卡片只有标题、来源和封面，没有跳转链接，
// 视频解析等插件拿不到地址。静默群里的卡片改由野生号解析（它拿得到完整卡片），
// 解析结果再交给官方机器人发送；官方机器人收到的同一张卡片跳过，避免两边重复处理。
loader._wildSilenceDeal ??= loader.deal
loader.deal = function (e) {
  if (e?.post_type === "message" && e.message_type === "group") {
    if (isSilenced(e.self_id, e.group_id)) {
      if (!hasCardSegment(e)) return
      e._wildCardParse = true
      return cardParsing.run(true, () => loader._wildSilenceDeal.call(this, e))
    }
    if (isOfficialCardForWild(e)) return
  }
  return loader._wildSilenceDeal.call(this, e)
}

/** 野生号收到的消息是否带卡片（json / xml 消息段） */
function hasCardSegment(e) {
  return Array.isArray(e.message) && e.message.some(i => i?.type === "json" || i?.type === "xml")
}

/** 官方机器人收到的卡片，同群有静默中的野生号会解析同一张卡片 */
function isOfficialCardForWild(e) {
  return String(e.self_id) === officialId() && !!e.raw?.ark_data && !!silencedWild(e.group_id)
}

// 群绑定后，野生号和官方机器人收到的同一条消息 group_id / user_id 完全相同。
// 野生号通常先收到，它触发的 groupCD / singleCD 会把官方机器人随后收到的同一条命令挡掉，
// 表现为静默群里所有命令都没人回。上面的 deal 拦截之外再保留一层，防止其他路径设置冷却。
loader._wildSilenceSetLimit ??= loader.setLimit
loader.setLimit = function (e, config) {
  if (e?.isGroup && isSilenced(e.self_id, e.group_id)) return
  return loader._wildSilenceSetLimit.call(this, e, config)
}

/* ---------- 官方机器人发不了、做不到的交给野生号 ---------- */

function hookOfficial() {
  const adapter = Bot.adapter?.find(a => a.id === "QQBot")
  if (!adapter?.sendGroupMsg) return false
  // 保存最初的发送函数，热重载时重新包一层，不会越包越多
  adapter._wildCardOrig ??= adapter.sendGroupMsg
  adapter._wildFriendOrig ??= adapter.sendFriendMsg
  adapter.sendGroupMsg = makeWildRelay(adapter, adapter._wildCardOrig, "group")
  if (adapter._wildFriendOrig) adapter.sendFriendMsg = makeWildRelay(adapter, adapter._wildFriendOrig, "friend")
  installWildAssist(adapter)
  logger.mark("[野生号辅助] 官方机器人发不了的消息、没有的功能改由野生号代办")
  return true
}

// OneBotv11 / QQBot 适配器可能比本插件晚加载，等它出现再接管
for (const hook of [hookAdapter, hookOfficial])
  if (!hook()) {
    let n = 0
    const timer = setInterval(() => {
      if (hook() || ++n > 120) clearInterval(timer)
    }, 1000)
  }

/* ---------- 状态：官方机器人在静默群里能否发主动消息 ---------- */

// 群里关闭“允许主动发送”后，官方机器人的主动消息一律返回 40034105，定时消息只能交给野生号或丢弃
async function proactiveState(gid) {
  const id = officialId()
  const bot = id && Bot[id]
  if (!bot?.sdk?.getGroupBotState) return "官方机器人不在线"
  const openid = await translateGroupToOpenid(bot, gid)
  if (!openid) return "未绑定群"
  try {
    const { allow_proactive_msg } = await bot.sdk.getGroupBotState(openid)
    return allow_proactive_msg ? "开启" : "关闭"
  } catch (err) {
    return `查询失败（${err?.code ?? err?.message ?? err}）`
  }
}

/** 这个群里是否有未静默、会自己处理消息的野生号 */
function wildHandles(gid) {
  return (Bot.uin || []).map(String).some(id =>
    isWild(id) &&
    !isSilenced(id, gid) &&
    (Bot[id]?.gl?.has(Number(gid)) || Bot[id]?.gl?.has(String(gid))),
  )
}

/* ---------- 命令 ---------- */

export class WildSilencePlugin extends plugin {
  constructor() {
    super({
      name: "野生号静默",
      dsc: "白名单群里野生号不处理消息、不主动发言，交给官方机器人",
      event: "message",
      priority: -99999,
      rule: [
        // 拦截规则放第一条：静默群里连管理命令也不响应
        { reg: "", fnc: "check", log: false },
        { reg: "^#野生静默(开启|关闭)\\s*(\\d+)?$", fnc: "toggleGroup" },
        { reg: "^#野生静默总开关(开启|关闭)$", fnc: "toggleAll" },
        { reg: "^#野生静默定时(官方|柴郡|野生|不发)$", fnc: "setCron" },
        { reg: "^#野生静默(状态|列表)$", fnc: "status" },
      ],
    })
  }

  // 正常情况下静默群里野生号的消息已在 loader.deal 入口丢弃，到不了这里；
  // 以下 accept / check 作为兜底：回复一律作废，规则阶段直接拦截
  // 卡片消息（e._wildCardParse）放行，由野生号解析
  accept(e) {
    if (e.isGroup && !e._wildCardParse && isSilenced(e.self_id, e.group_id)) e.reply = async () => false
    return false
  }

  // true = 拦截，后续插件都不处理；false = 放行
  check(e) {
    return !!e.isGroup && !e._wildCardParse && isSilenced(e.self_id, e.group_id)
  }

  // 管理命令只有主人能用，优先由野生号处理（它拿得到真实群号）。
  // 静默群里野生号的消息在入口就被丢弃，私聊或没有野生号的群也收不到，
  // 这些地方改由官方机器人处理；野生号正常处理的群里官方机器人不响应，避免同一条命令回两遍
  canManage(e) {
    if (!e.isMaster) return false
    if (isWild(e.self_id)) return true
    return String(e.self_id) === officialId() && !(e.isGroup && wildHandles(e.group_id))
  }

  async toggleGroup(e) {
    if (!this.canManage(e)) return false
    const [, act, arg] = e.msg.match(/^#野生静默(开启|关闭)\s*(\d+)?$/)
    const gid = Number(arg || e.group_id)
    if (!Number.isInteger(gid) || gid <= 0) {
      await e.reply("请带上群号，例如：#野生静默开启123456789")
      return true
    }
    const groups = cfg.groups.map(Number)
    cfg.groups = act === "开启" ? [...new Set([...groups, gid])] : groups.filter(g => g !== gid)
    save()
    await e.reply(`群 ${gid} 已${act}野生号静默`)
    return true
  }

  async toggleAll(e) {
    if (!this.canManage(e)) return false
    cfg.enable = e.msg.includes("开启")
    save()
    await e.reply(`野生号静默总开关：${cfg.enable ? "开启" : "关闭"}`)
    return true
  }

  async setCron(e) {
    if (!this.canManage(e)) return false
    const key = e.msg.match(/(官方|柴郡|野生|不发)$/)[1]
    cfg.cron = { 官方: "official", 柴郡: "official", 野生: "wild", 不发: "block" }[key]
    save()
    await e.reply(`静默群的定时消息：${CRON_NAME[cfg.cron]}`)
    return true
  }

  async status(e) {
    if (!this.canManage(e)) return false
    const lines = []
    for (const gid of cfg.groups) lines.push(`${gid} 主动消息：${await proactiveState(gid)}`)
    const list = lines.length ? lines.join("\n") : "（空）"
    const tip = lines.some(line => line.endsWith("关闭"))
      ? "\n主动消息关闭的群，官方机器人发不了定时消息，需群管理在机器人资料页开启"
      : ""
    await e.reply(
      `总开关：${cfg.enable ? "开启" : "关闭"}\n` +
        `官方机器人：${officialId() || "未找到"}\n` +
        `定时消息：${CRON_NAME[cfg.cron]}\n静默群：\n${list}${tip}`,
    )
    return true
  }
}
