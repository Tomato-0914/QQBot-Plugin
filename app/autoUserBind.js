/**
 * 自动 QQ 绑定（无需群友发 #QQ绑定）
 *
 * 官方机器人和野生号同在一个群、且该群已做群绑定时，群友正常聊天，
 * 两边收到的同一条消息会把 openid 和 QQ 号对上，头像校验通过后自动保存映射。
 * 匹配规则见 lib/autoUserBind.js；配置 autoBindUser: false 可关闭。
 */
import { config } from "../lib/config.js"
import { createAutoUserBind, textKey } from "../lib/autoUserBind.js"
import { getAppid, isGuildUserId, isQQUin } from "../lib/uinMap.js"
import { isWild } from "../lib/wildSilence.js"

// 状态放在全局，热重载时不会重复注册监听
const state = (globalThis.__autoUserBind ??= { hooked: false })
state.binder ??= createAutoUserBind()

state.handler = data => {
  if (config.autoBindUser === false) return
  // 官方机器人这边的群未做群绑定时 group_id 是群 openid，和野生号的群号对不上
  const group = String(data.group_id ?? "")
  if (!/^\d+$/.test(group)) return
  const key = textKey(data.message)
  if (!key) return

  if (data.bot?.adapter?.id === "QQBot") {
    if (isQQUin(data.user_id)) return // 已绑定
    const openid = String(data._raw_user_id || data.sender?._raw_user_id || data.user_id || "")
    if (!openid || isGuildUserId(openid)) return
    state.binder.onOfficial({ appid: getAppid(data.bot || data.self_id), group, openid, key })
  } else if (isWild(data.self_id)) {
    const uin = String(data.user_id ?? "")
    if (!isQQUin(uin) || (Bot.uin || []).map(String).includes(uin)) return
    state.binder.onWild({ group, uin, key })
  }
}

if (!state.hooked) {
  state.hooked = true
  Bot.on("message.group.normal", data => state.handler?.(data))
}
