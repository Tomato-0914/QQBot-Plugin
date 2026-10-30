/**
 * 入群申请提示：收到申请时在申请的群里发一条提示
 *   - 官方机器人：带「✅ 同意」「❌ 拒绝」按钮，只有主人能点。按钮点击后发出 #QQBot同意入群 / #QQBot拒绝入群 <申请ID>，
 *     由 app/joinRequest.js 处理；指令同时写进按钮的 action.data，按钮在重启或超过 5 分钟后仍然有效
 *   - 野生号（OneBotv11 / ICQQ）：不发按钮，主人引用回复提示消息「同意」或「拒绝」
 * 两种提示都可以引用回复处理。官方机器人和野生号都收到同一个人的申请时只提示一次。
 * 配置 joinRequestNotify: false 可关闭提示（事件照常下发给其他插件）
 */

/** 本次运行收到的申请：申请 ID → 申请信息；重启后官方机器人的申请由 #QQBot入群申请 从接口重新查询 */
const state = (globalThis.__qqbotJoinRequest ??= { pending: new Map(), prompts: new Map(), claimed: new Map() })
const { pending, prompts, claimed } = state
const MAX_PENDING = 500
/** 同一个人在同一个群的申请多久内只提示一次 */
const CLAIM_TTL = 10 * 60 * 1000

function trim (map, max) {
  while (map.size > max) map.delete(map.keys().next().value)
}

export function rememberRequest (req) {
  if (!req?.flag) return
  pending.delete(req.flag)
  pending.set(req.flag, req)
  trim(pending, MAX_PENDING)
}

export const getRememberedRequest = flag => pending.get(flag)
export const forgetRequest = flag => pending.delete(flag)

/** 某个群里记下的申请（group_id 为事件里的群号） */
export const rememberedRequestsOf = groupId =>
  [...pending.values()].filter(req => String(req.group_id) === String(groupId))

/** 记下提示消息的 ID，主人引用回复时据此找到申请 */
function indexPrompt (ret, flag) {
  for (const id of [ret?.message_id].flat()) {
    if (id === undefined || id === null || id === "") continue
    prompts.set(String(id), flag)
  }
  trim(prompts, MAX_PENDING * 2)
}

/** 被引用的提示对应的申请 */
export function requestOfPrompt (messageIds) {
  for (const id of messageIds) {
    const flag = prompts.get(String(id))
    if (flag && pending.has(flag)) return pending.get(flag)
  }
}

/** 同一个人在同一个群的申请 10 分钟内只提示一次，返回 false 表示已经有机器人提示过 */
function claim (req) {
  const key = `${req.group_id}:${req.user_id}`
  const now = Date.now()
  for (const [k, time] of claimed) if (now - time > CLAIM_TTL) claimed.delete(k)
  if (claimed.has(key)) return false
  claimed.set(key, now)
  return true
}

export function requestText (req) {
  const name = req.nickname ? `${req.nickname}(${req.user_id})` : String(req.user_id)
  const from = req.invited_by || req.sub_type === "invite" ? `（${req.invited_by ? `由 ${req.invited_by} ` : "群友"}邀请）` : ""
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

/** 同意或拒绝一条记下的申请 */
export async function decideRequest (req, approve) {
  if (req.source === "wild") {
    await req.approve(approve)
  } else {
    const group = globalThis.Bot[req.self_id].pickGroup(req.group_id)
    await group.setAddRequest(req._raw_user_id || req.member_openid || req.user_id, req.flag, approve)
  }
  forgetRequest(req.flag)
}

/** 官方机器人收到入群申请：记下申请并在群里发带按钮的提示 */
export async function notifyJoinRequest (data) {
  const req = {
    flag: data.flag,
    self_id: data.self_id,
    group_id: data.group_id,
    user_id: data.user_id,
    _raw_user_id: data._raw_user_id,
    nickname: data.nickname,
    comment: data.comment,
    sub_type: data.sub_type,
    invited_by: data.invited_by,
  }
  rememberRequest(req)
  if (!claim(req)) return
  try {
    indexPrompt(await data.reply([requestText(req), requestButtons(req.flag)]), req.flag)
  } catch (err) {
    Bot.makeLog("error", ["发送入群申请提示失败", err], data.self_id)
  }
}

/**
 * 野生号收到入群申请（request.group.add）：记下申请，在群里发提示，主人引用回复「同意」或「拒绝」。
 * OneBot 的 request.group.invite 是邀请机器人自己进群，不在这里处理
 */
export async function notifyWildJoinRequest (e) {
  if (e.sub_type !== "add" || !e.flag) return
  // TRSS 的 OneBotv11 在事件上提供 e.approve；没有时直接调用 set_group_add_request
  let approve
  if (typeof e.approve === "function") approve = value => e.approve(value)
  else if (typeof e.bot?.sendApi === "function")
    approve = value => e.bot.sendApi("set_group_add_request", { flag: e.flag, sub_type: "add", approve: value })
  else return
  let nickname = e.nickname || e.sender?.nickname
  if (!nickname) {
    try {
      nickname = (await e.bot.pickFriend(e.user_id).getInfo?.())?.nickname
    } catch {}
  }
  const invitor = Number(e.invitor_id) ? String(e.invitor_id) : ""
  const req = {
    source: "wild",
    flag: String(e.flag),
    self_id: e.self_id,
    group_id: e.group_id,
    user_id: e.user_id,
    nickname,
    comment: String(e.comment || "").trim(),
    invited_by: invitor,
    approve,
  }
  rememberRequest(req)
  if (!claim(req)) return
  try {
    const text = `${requestText(req)}\n主人引用回复这条消息「同意」或「拒绝」`
    indexPrompt(await e.bot.pickGroup(e.group_id).sendMsg(text), req.flag)
  } catch (err) {
    Bot.makeLog("error", ["发送入群申请提示失败", err], e.self_id)
  }
}

const DECISION = /^#?(同意|拒绝)(入群|申请)?$/

/** 消息里引用的消息 ID：野生号的 reply 消息段，官方机器人的 source.seq */
function quotedIds (e) {
  const ids = []
  for (const seg of e.message || [])
    if (seg?.type === "reply") ids.push(seg.id ?? seg.data?.id)
  ids.push(e.reply_id, e.source?.message_id, e.source?.seq)
  return ids.filter(id => id !== undefined && id !== null && id !== "")
}

const textOf = e =>
  (e.message || []).filter(i => i?.type === "text").map(i => i.text ?? i.data?.text ?? "").join("").trim()

/**
 * 主人引用回复提示消息「同意」/「拒绝」时处理申请；不是这种消息时返回 false。
 * 官方机器人和野生号可能都收到同一条回复，只处理一次
 */
export async function handleQuoteDecision (e, isMaster) {
  const match = textOf(e).match(DECISION)
  if (!match) return false
  const req = requestOfPrompt(quotedIds(e))
  if (!req || req.deciding || !isMaster(e)) return false
  // 同步标记，loader 处理这条消息前就能看到，app/joinRequest.js 据此不再交给其他插件
  req.deciding = true
  e._joinRequestDecision = true
  const approve = match[1] === "同意"
  const name = req.nickname ? `${req.nickname}(${req.user_id})` : String(req.user_id)
  try {
    await decideRequest(req, approve)
    await e.reply(`已${approve ? "同意" : "拒绝"} ${name} 的入群申请`)
  } catch (err) {
    req.deciding = false
    await e.reply(`${approve ? "同意" : "拒绝"} ${name} 的入群申请失败：${err?.message || err}`)
  }
  return true
}
