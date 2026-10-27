/**
 * #一键群绑定
 *
 * 野生号在每个有官方机器人的群里 @官方机器人 发一条带随机校验码的消息，
 * 官方机器人收到后就知道 群openid ↔ 真实群号，写入群绑定表，最后撤回校验消息。
 * 效果等同于逐个群发 #群绑定群号。私聊野生号使用。
 */
import crypto from "node:crypto"
import plugin from "../../../lib/plugins/plugin.js"
import { getAppid } from "../lib/uinMap.js"
import { saveGroupMapping, translateGroupToOpenid } from "../lib/groupMap.js"
import { isWild, officialId } from "../lib/wildSilence.js"

const WAIT = 30000 // 每个群等官方机器人收到校验消息的最长时间（毫秒）
const GAP = 1500   // 两个群之间的发送间隔，防风控

// 状态放在全局，热重载时不会重复注册监听
const state = (globalThis.__autoGroupBind ??= { pending: new Map(), hooked: false })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const textOf = data =>
  (data.message || []).filter(i => i.type === "text").map(i => i.text || "").join("") ||
  String(data.raw_message || "")

// 官方机器人这边：收到校验码，把 群openid ↔ 真实群号 存进群绑定表
state.handler = async data => {
  if (data.bot?.adapter?.id !== "QQBot") return
  const token = textOf(data).match(/群绑定校验\s*([0-9a-f]{8})/)?.[1]
  const task = token && state.pending.get(token)
  if (!task || String(data.self_id) !== String(task.official)) return
  state.pending.delete(token)
  try {
    const openid = String(data._raw_group_id || data.group_id || "")
    const ok = await saveGroupMapping(getAppid(data.bot || data.self_id), openid, task.gid)
    task.resolve(ok ? "ok" : "保存失败")
  } catch (err) {
    task.resolve(`保存出错：${err?.message || err}`)
  }
}
if (!state.hooked) {
  state.hooked = true
  Bot.on("message.group", data => state.handler?.(data))
}

export class AutoGroupBindPlugin extends plugin {
  constructor() {
    super({
      name: "一键群绑定",
      dsc: "让野生号在群里@官方机器人发校验码，自动完成 #群绑定",
      event: "message",
      priority: -100000, // 比野生号静默更早，静默群里也能触发
      rule: [{ reg: "^#一键群绑定(全部)?$", fnc: "bindAll" }],
    })
  }

  async bindAll(e) {
    if (!isWild(e.self_id) || !e.isMaster) return false
    const wild = e.bot || Bot[e.self_id]
    const oid = officialId()
    const official = oid && Bot[oid]
    if (!official) return e.reply("官方机器人不在线，无法绑定")

    const force = e.msg.includes("全部") // 带“全部”时连已绑定的群也重新绑一遍
    const groups = [...(wild.gl?.keys() || [])].map(Number).filter(Boolean)
    await e.reply(`开始检查 ${groups.length} 个群，官方机器人在的群会自动绑定，请稍候…`)

    const done = [], skipped = [], failed = []
    for (const gid of groups) {
      if (!force && (await translateGroupToOpenid(official, gid))) {
        skipped.push(gid)
        continue
      }
      // 官方机器人不在这个群就跳过
      let present = false
      try {
        const members = await wild.pickGroup(gid).getMemberMap()
        present = members.has(Number(oid)) || members.has(String(oid))
      } catch {}
      if (!present) continue

      const token = crypto.randomBytes(4).toString("hex")
      const result = new Promise(resolve => {
        state.pending.set(token, { gid, official: oid, resolve })
        setTimeout(() => resolve("官方机器人没收到校验消息"), WAIT)
      })

      // 直接调接口发送，绕开野生号静默的拦截
      let sent
      try {
        sent = await wild.sendApi("send_group_msg", {
          group_id: gid,
          message: [
            { type: "at", data: { qq: String(oid) } },
            { type: "text", data: { text: ` 群绑定校验 ${token}（自动撤回）` } },
          ],
        })
      } catch {
        state.pending.delete(token)
        failed.push(`${gid}：校验消息发送失败`)
        continue
      }

      const res = await result
      state.pending.delete(token)
      if (sent?.message_id) wild.sendApi("delete_msg", { message_id: sent.message_id }).catch(() => {})
      if (res === "ok") done.push(gid)
      else failed.push(`${gid}：${res}`)
      await sleep(GAP)
    }

    const lines = [`绑定成功 ${done.length} 个`]
    if (done.length) lines.push(...done.map(g => `✅ ${g}`))
    if (skipped.length) lines.push(`已绑定跳过 ${skipped.length} 个`)
    if (failed.length) lines.push(`失败 ${failed.length} 个：`, ...failed.map(f => `❌ ${f}`))
    await e.reply(lines.join("\n"))
    return true
  }
}
