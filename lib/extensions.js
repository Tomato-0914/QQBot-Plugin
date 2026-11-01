/**
 * 适配器扩展接口：其他插件通过这里挂接发送流程、补充对象方法，不需要改写适配器内部方法
 *
 *   const adapter = Bot.adapter.find(a => a.id === "QQBot")
 *   adapter.use("名称", {
 *     // 群聊 / 私聊发送前调用；scope 为 "group" 或 "friend"，next(data, msg) 交给下一个扩展、最后由适配器发送
 *     send (scope, data, msg, next) { return next(data, msg) },
 *     // pickFriend / pickMember / pickGroup 返回对象前调用；kind 为 "friend" / "member" / "group"
 *     // ctx 为 { self_id, group_id, user_id }，返回（可以是修改后的）对象
 *     pick (kind, obj, ctx) { return obj },
 *   })
 *   adapter.unuse("名称")
 *
 * 同名扩展重复注册时替换旧的，插件热重载不会叠加。
 * adapter.mapping 提供 openid 与 QQ 号 / 群号的映射查询、保存和头像校验。
 */
import { forwardToMarkdown } from "./forwardMarkdown.js"
import * as avatar from "./avatarVerify.js"
import * as uinMap from "./uinMap.js"
import * as groupMap from "./groupMap.js"

export const mapping = {
  /** 机器人的 appid，映射表按 appid 区分 */
  getAppid: botOrId => uinMap.getAppid(botOrId),
  isQQUin: value => uinMap.isQQUin(value),
  isGuildUserId: value => uinMap.isGuildUserId(value),
  /** openid → QQ 号，未绑定返回 false */
  getMappedUin: (appid, openid) => uinMap.getMappedUin(appid, openid),
  /** QQ 号 → openid，未绑定返回 false */
  getMappedOpenid: (appid, uin) => uinMap.getMappedOpenid(appid, uin),
  /** 保存 openid ↔ QQ 号 */
  saveMapping: (appid, openid, uin) => uinMap.saveMapping(appid, openid, uin),
  /** QQ 号或 openid → openid */
  translateToOpenid: (botOrId, userId) => uinMap.translateToOpenid(botOrId, userId),
  /** 群 openid → 真实群号，未绑定返回假值 */
  getGroupUin: (botOrId, groupOpenid) => groupMap.getGroupUin(botOrId, groupOpenid),
  /** 真实群号 → 群 openid，未绑定返回假值 */
  translateGroupToOpenid: (botOrId, groupUin) => groupMap.translateGroupToOpenid(botOrId, groupUin),
  /** 保存群 openid ↔ 真实群号 */
  saveGroupMapping: (appid, groupOpenid, groupUin) => groupMap.saveGroupMapping(appid, groupOpenid, groupUin),
  /** 头像校验（同 #QQ绑定），返回 { ok, custom } */
  checkAvatar: (appid, openid, uin) => avatar.checkAvatar(appid, openid, uin),
}

const SEND = { group: "sendGroupMsg", friend: "sendFriendMsg" }
const PICK = { friend: "pickFriend", member: "pickMember", group: "pickGroup" }

export function installExtensions(adapter) {
  const extensions = new Map()
  adapter.extensions = extensions
  adapter.mapping = mapping
  adapter.use = (name, hooks) => {
    extensions.set(String(name), hooks || {})
    return () => adapter.unuse(name)
  }
  adapter.unuse = name => extensions.delete(String(name))

  const hooksOf = type => [...extensions.values()].filter(hooks => typeof hooks[type] === "function")

  for (const [scope, key] of Object.entries(SEND)) {
    const base = adapter[key]
    if (typeof base !== "function") continue
    adapter[key] = function (data, msg) {
      // 纯文字的合并转发转成一条 Markdown，扩展收到的已经是转换后的消息
      if (adapter.config?.forwardMarkdown !== false) msg = forwardToMarkdown(msg)
      const chain = hooksOf("send")
      const run = (i, d, m) =>
        i < chain.length
          ? chain[i].send.call(adapter, scope, d, m, (nd = d, nm = m) => run(i + 1, nd, nm))
          : base.call(adapter, d, m)
      return run(0, data, msg)
    }
  }

  for (const [kind, key] of Object.entries(PICK)) {
    const base = adapter[key]
    if (typeof base !== "function") continue
    adapter[key] = function (self_id, ...args) {
      let obj = base.call(this, self_id, ...args)
      if (!obj) return obj
      const ctx = kind === "member"
        ? { self_id, group_id: args[0], user_id: args[1] }
        : kind === "group"
          ? { self_id, group_id: args[0] }
          : { self_id, user_id: args[0] }
      for (const hooks of hooksOf("pick")) {
        try {
          obj = hooks.pick.call(adapter, kind, obj, ctx) || obj
        } catch (err) {
          Bot.makeLog("error", [`扩展处理 ${key} 失败`, err], self_id)
        }
      }
      return obj
    }
  }
}
