/**
 * 野生号静默
 *
 * 白名单群里，野生号（OneBotv11 / ICQQ）不处理任何消息、不主动发言，全部交给官方机器人：
 *   - 收到的消息：accept 阶段作废野生号的回复，规则阶段直接拦截
 *   - 定时任务 / 主动推送：接管野生号的群消息发送，按配置改由官方机器人发、照发或丢弃
 */
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

const CRON_NAME = { official: "改由官方机器人发", wild: "野生号照发", block: "不发" }

// 官方机器人发不了的消息类型（戳一戳、json/xml 卡片等），直接交给野生号
const WILD_ONLY = new Set(["poke", "json", "xml", "music", "file"])
const wildOnly = msg => (Array.isArray(msg) ? msg : [msg]).some(s => WILD_ONLY.has(s?.type))

/* ---------- 接管野生号的群消息发送（定时任务、主动推送都走这里） ---------- */

async function sendSilenced(orig, self, fn, data, msg) {
  const tag = `[野生号静默] 群 ${data.group_id}`
  if (cfg.cron === "wild") return orig.call(self, data, msg)
  if (cfg.cron === "block") {
    logger.mark(`${tag} 已拦截野生号的主动消息`)
    return { message_id: [], error: [] }
  }
  if (wildOnly(msg)) return orig.call(self, data, msg)

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

  try {
    // 合并转发交给官方机器人时包成 node 消息，由本适配器自动拍平
    const content = fn === "sendGroupForwardMsg" ? { type: "node", data: msg } : msg
    const ret = await bot.pickGroup(String(data.group_id)).sendMsg(content)
    if (ret?.error?.length && !ret.message_id?.length) throw ret.error[0]
    logger.mark(`${tag} 主动消息已改由官方机器人发送`)
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
      if (isSilenced(data.self_id, data.group_id)) return sendSilenced(orig, this, fn, data, msg)
      return orig.call(this, data, msg)
    }
  }
  logger.mark("[野生号静默] 已接管野生号的群消息发送")
  return true
}

/* ---------- 冷却：静默群里野生号收到的消息不占用冷却 ---------- */

// 群绑定后，野生号和官方机器人收到的同一条消息 group_id / user_id 完全相同。
// 野生号通常先收到，它触发的 groupCD / singleCD 会把官方机器人随后收到的同一条命令挡掉，
// 表现为静默群里所有命令都没人回。静默群里野生号本来就不处理消息，不该设置冷却。
loader._wildSilenceSetLimit ??= loader.setLimit
loader.setLimit = function (e, config) {
  if (e?.isGroup && isSilenced(e.self_id, e.group_id)) return
  return loader._wildSilenceSetLimit.call(this, e, config)
}

// OneBotv11 适配器可能比本插件晚加载，等它出现再接管
if (!hookAdapter()) {
  let n = 0
  const timer = setInterval(() => {
    if (hookAdapter() || ++n > 120) clearInterval(timer)
  }, 1000)
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

  // accept 比所有插件的规则都先执行：静默群里野生号对消息的回复一律作废，
  // 官方机器人会处理同一条消息；这样优先级更高的插件也不会让野生号插嘴
  accept(e) {
    if (e.isGroup && isSilenced(e.self_id, e.group_id)) e.reply = async () => false
    return false
  }

  // true = 拦截，后续插件都不处理；false = 放行
  check(e) {
    return !!e.isGroup && isSilenced(e.self_id, e.group_id)
  }

  // 管理命令只由野生号处理（它拿得到真实群号），且只有主人能用
  canManage(e) {
    return isWild(e.self_id) && e.isMaster
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
    const list = cfg.groups.length ? cfg.groups.join("\n") : "（空）"
    await e.reply(
      `总开关：${cfg.enable ? "开启" : "关闭"}\n` +
        `官方机器人：${officialId() || "未找到"}\n` +
        `定时消息：${CRON_NAME[cfg.cron]}\n静默群：\n${list}`,
    )
    return true
  }
}
