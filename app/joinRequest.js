/**
 * 入群申请处理命令（仅官方机器人，仅主人，在申请的群里使用）
 *   #QQBot入群申请          查询本群待处理的入群申请，每条带同意 / 拒绝按钮
 *   #QQBot同意入群 [申请ID]  同意；本群只有一条待处理申请时可以不填 ID
 *   #QQBot拒绝入群 [申请ID]  拒绝
 * 收到申请时的提示和按钮由 lib/joinRequestNotify.js 发送
 */
import plugin from "../../../lib/plugins/plugin.js"
import {
  forgetRequest,
  getRememberedRequest,
  rememberRequest,
  rememberedRequestsOf,
  requestButtons,
  requestText,
} from "../lib/joinRequestNotify.js"

const errorText = err => {
  const code = err?.code ?? err?.err_code ?? err?.response?.data?.code
  return `${err?.message || err}${code && !String(err?.message).includes(code) ? `（错误码 ${code}）` : ""}`
}

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
      await e.bot.pickGroup(e.group_id).setAddRequest(req._raw_user_id || req.member_openid || req.user_id, req.flag, approve)
    } catch (err) {
      return this.reply(`${approve ? "同意" : "拒绝"} ${name} 的入群申请失败：${errorText(err)}`)
    }
    forgetRequest(req.flag)
    return this.reply(`已${approve ? "同意" : "拒绝"} ${name} 的入群申请`)
  }
}
