/**
 * 入群申请处理
 *
 * 官方机器人的命令（仅主人，在申请的群里使用）：
 *   #QQBot入群申请          查询本群待处理的入群申请，每条带同意 / 拒绝按钮
 *   #QQBot同意入群 [申请ID]  同意；本群只有一条待处理申请时可以不填 ID
 *   #QQBot拒绝入群 [申请ID]  拒绝
 * 野生号收到申请时在群里发提示，主人引用回复「同意」或「拒绝」处理（官方机器人的提示也可以这样回复）。
 * 提示由 lib/joinRequestNotify.js 发送
 */
import plugin from "../../../lib/plugins/plugin.js"
import loader from "../../../lib/plugins/loader.js"
import cfg from "../../../lib/config/config.js"
import {
  decideRequest,
  getRememberedRequest,
  handleQuoteDecision,
  joinRequestError,
  notifyWildJoinRequest,
  rememberRequest,
  rememberedRequestsOf,
  requestButtons,
  requestText,
} from "../lib/joinRequestNotify.js"
import { config } from "../lib/config.js"
import { isWild } from "../lib/wildSilence.js"

/** 发消息的人是不是主人：loader 设置 e.isMaster 之前就要判断，按 other.yaml 的主人名单 */
export function isMasterOf (e) {
  const list = [...(cfg.master?.[e.self_id] || []), ...(cfg.masterQQ || [])].map(String)
  return list.includes(String(e.user_id))
}

// 用 Bot.on 而不是插件规则：野生号静默的群里，消息不会进入插件，引用回复也要能处理。
// 状态放在全局，热重载时不会重复注册监听
const hooks = (globalThis.__qqbotJoinRequestHooks ??= { installed: false })
hooks.onRequest = e => {
  if (config.joinRequestNotify === false || !isWild(e.self_id)) return
  notifyWildJoinRequest(e).catch(err => Bot.makeLog("error", ["处理入群申请失败", err], e.self_id))
}
hooks.onMessage = e => {
  handleQuoteDecision(e, isMasterOf).catch(err => Bot.makeLog("error", ["处理入群申请回复失败", err], e.self_id))
}
if (!hooks.installed) {
  hooks.installed = true
  Bot.on("request.group.add", e => hooks.onRequest(e))
  Bot.on("message.group", e => hooks.onMessage(e))
}

// 主人引用回复「同意」/「拒绝」处理了申请的消息，不再交给其他插件（避免被当成和机器人对话）
loader._joinRequestDeal ??= loader.deal
loader.deal = function (e) {
  if (e?._joinRequestDecision) return
  return loader._joinRequestDeal.call(this, e)
}

const errorText = joinRequestError

export class JoinRequestPlugin extends plugin {
  constructor () {
    super({
      name: "QQBot入群申请",
      dsc: "查询、同意、拒绝官方机器人所在群的入群申请",
      event: "message",
      priority: 0,
      rule: [
        { reg: /^#QQBot入群申请(列表)?$/i, fnc: "list", permission: "master" },
        { reg: /^#QQBot(同意|拒绝)入群\s*(\S*)$/i, fnc: "decide", permission: "master" },
      ],
    })
  }

  /** 只处理官方机器人的群消息（含按钮点击） */
  check (e) {
    if (e.bot?.adapter?.id !== "QQBot") return false
    if (!e.group_id) {
      this.reply("请在申请的群里使用")
      return false
    }
    return true
  }

  async fetchRequests (e) {
    const list = await e.bot.pickGroup(e.group_id).getJoinRequestList()
    for (const req of list) rememberRequest({ ...req, self_id: e.self_id, group_id: e.group_id, _raw_user_id: req.member_openid })
    return list
  }

  async list (e) {
    if (!this.check(e)) return false
    let list
    try {
      list = await this.fetchRequests(e)
    } catch (err) {
      return this.reply(`查询入群申请失败：${errorText(err)}`)
    }
    if (!list.length) return this.reply("本群没有待处理的入群申请")
    const shown = list.slice(0, 5)
    for (const req of shown) await this.reply([requestText(req), requestButtons(req.flag)])
    if (list.length > shown.length) await this.reply(`还有 ${list.length - shown.length} 条申请没有列出，处理完这些后再查询`)
    return true
  }

  async decide (e) {
    if (!this.check(e)) return false
    const [, action, flagArg] = e.msg.match(/^#QQBot(同意|拒绝)入群\s*(\S*)$/i)
    const approve = action === "同意"

    let req = flagArg ? getRememberedRequest(flagArg) : undefined
    if (req && String(req.group_id) !== String(e.group_id)) req = undefined
    if (!req) {
      let list
      try {
        list = await this.fetchRequests(e)
      } catch (err) {
        // 查询接口不可用时，仍可按按钮带来的申请 ID 和本次运行记下的信息处理
        if (!flagArg) return this.reply(`查询入群申请失败：${errorText(err)}`)
        list = []
      }
      if (flagArg) req = list.find(item => item.flag === flagArg)
      else if (list.length === 1) req = list[0]
      else if (list.length > 1) return this.reply("本群有多条待处理申请，请发送 #QQBot入群申请 后点按钮处理")
      if (!req) {
        const remembered = rememberedRequestsOf(e.group_id)
        if (!flagArg && remembered.length === 1) req = remembered[0]
      }
    }
    if (!req) return this.reply("没有找到这条入群申请，可能已经处理过了")

    const name = req.nickname ? `${req.nickname}(${req.user_id})` : String(req.user_id)
    try {
      await decideRequest({ ...req, self_id: req.self_id || e.self_id, group_id: req.group_id || e.group_id }, approve)
    } catch (err) {
      return this.reply(`${approve ? "同意" : "拒绝"} ${name} 的入群申请失败：${errorText(err)}`)
    }
    return this.reply(`已${approve ? "同意" : "拒绝"} ${name} 的入群申请`)
  }
}
