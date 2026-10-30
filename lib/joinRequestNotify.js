/**
 * 入群申请提示：收到申请时在申请的群里发一条提示，带「✅ 同意」「❌ 拒绝」按钮，只有主人能点
 *
 * 按钮点击后发出 #QQBot同意入群 / #QQBot拒绝入群 <申请ID>，由 app/joinRequest.js 处理。
 * 指令同时写进按钮的 action.data，按钮在重启或超过 5 分钟后仍然有效。
 * 配置 joinRequestNotify: false 可关闭提示（事件照常下发给其他插件）
 */

/** 本次运行收到的申请：join_request_id → 申请信息；重启后由 #QQBot入群申请 从接口重新查询 */
const pending = new Map()
const MAX_PENDING = 500

export function rememberRequest (req) {
  if (!req?.flag) return
  pending.delete(req.flag)
  pending.set(req.flag, req)
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value)
}

export const getRememberedRequest = flag => pending.get(flag)
export const forgetRequest = flag => pending.delete(flag)

/** 某个群里记下的申请（group_id 为事件里的群号） */
export const rememberedRequestsOf = groupId =>
  [...pending.values()].filter(req => String(req.group_id) === String(groupId))

export function requestText (req) {
  const name = req.nickname ? `${req.nickname}(${req.user_id})` : String(req.user_id)
  const from = req.invited_by || req.sub_type === "invite" ? "（群友邀请）" : ""
  return `【入群申请】${name} 申请加入本群${from}${req.comment ? `\n${req.comment}` : ""}`
}

function commandButton (text, command) {
  return { text, callback: command, permission: "master", QQBot: { action: { data: command } } }
}

export function requestButtons (flag) {
  return {
    type: "button",
    data: [[
      commandButton("✅ 同意", `#QQBot同意入群 ${flag}`),
      commandButton("❌ 拒绝", `#QQBot拒绝入群 ${flag}`),
    ]],
  }
}

/** 收到入群申请时调用：记下申请并在群里发提示 */
export async function notifyJoinRequest (data) {
  rememberRequest({
    flag: data.flag,
    self_id: data.self_id,
    group_id: data.group_id,
    user_id: data.user_id,
    _raw_user_id: data._raw_user_id,
    nickname: data.nickname,
    comment: data.comment,
    sub_type: data.sub_type,
    invited_by: data.invited_by,
  })
  try {
    await data.reply([requestText(data), requestButtons(data.flag)])
  } catch (err) {
    Bot.makeLog("error", ["发送入群申请提示失败", err], data.self_id)
  }
}
