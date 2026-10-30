import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/joinRequestNotify.test.js
// 入群申请提示：官方机器人发按钮，野生号引用回复确认；#QQBot入群申请 / #QQBot同意入群 / #QQBot拒绝入群
const listeners = {}
global.Bot = {
  makeLog () {},
  on: (name, fn) => { (listeners[name] ??= []).push(fn) },
}
const emit = async (name, e) => {
  for (const fn of listeners[name] || []) fn(e)
  await new Promise(resolve => setImmediate(resolve))
}

const notify = await import("../lib/joinRequestNotify.js")

await test("官方机器人：提示带申请人和验证信息，按钮只允许主人点且指令写进按钮", async () => {
  const sent = []
  await notify.notifyJoinRequest({
    self_id: "bot1",
    group_id: "123",
    user_id: "10001",
    _raw_user_id: "OPENID",
    nickname: "珂",
    comment: "问题：Wath's your name？\n答案：珂",
    flag: "REQ_1",
    sub_type: "add",
    reply: async msg => { sent.push(msg); return { message_id: ["OFFICIAL_MSG_1"] } },
  })
  const [text, button] = sent[0]
  assert.equal(text, "【入群申请】珂(10001) 申请加入本群\n问题：Wath's your name？\n答案：珂")
  assert.deepEqual(button.data[0].map(b => [b.text, b.callback, b.permission, b.QQBot.action.data]), [
    ["✅ 同意", "#QQBot同意入群 REQ_1", "master", "#QQBot同意入群 REQ_1"],
    ["❌ 拒绝", "#QQBot拒绝入群 REQ_1", "master", "#QQBot拒绝入群 REQ_1"],
  ])
  assert.equal(notify.getRememberedRequest("REQ_1")._raw_user_id, "OPENID")
  assert.equal(notify.requestText({ user_id: "x", sub_type: "invite" }), "【入群申请】x 申请加入本群（群友邀请）")
})

await test("发送提示失败不抛出", async () => {
  await notify.notifyJoinRequest({ flag: "REQ_ERR", group_id: "g", user_id: "u", reply: async () => { throw new Error("no") } })
})

// 命令和监听
const config = {}
mock.module(new URL("../../../lib/plugins/plugin.js", import.meta.url).href, {
  defaultExport: class {
    constructor (options) { Object.assign(this, options) }
  },
})
const dealt = []
const loader = { deal (e) { dealt.push(e) } }
mock.module(new URL("../../../lib/plugins/loader.js", import.meta.url).href, { defaultExport: loader })
mock.module(new URL("../../../lib/config/config.js", import.meta.url).href, {
  defaultExport: { master: { bot1: ["20000"], wild1: ["20000"] }, masterQQ: [] },
})
mock.module(new URL("../lib/config.js", import.meta.url).href, { namedExports: { config } })
mock.module(new URL("../lib/wildSilence.js", import.meta.url).href, {
  namedExports: { isWild: id => String(id).startsWith("wild") },
})
const { JoinRequestPlugin } = await import("../app/joinRequest.js")

const calls = []
let list = []
let listError
const group = {
  getJoinRequestList: async () => {
    calls.push(["list"])
    if (listError) throw listError
    return list
  },
  setAddRequest: async (...args) => {
    calls.push(["set", ...args])
    return true
  },
}
Bot.bot1 = { pickGroup: () => group }
const event = msg => ({ msg, self_id: "bot1", group_id: "123", bot: { adapter: { id: "QQBot" }, pickGroup: () => group } })
async function run (msg, e = event(msg)) {
  const app = new JoinRequestPlugin()
  const replies = []
  app.e = e
  app.reply = async reply => replies.push(reply)
  const rule = app.rule.find(r => r.reg.test(msg))
  assert.ok(rule, msg)
  assert.equal(rule.permission, "master")
  await app[rule.fnc](e)
  return replies
}

await test("点按钮同意：用记下的申请人 OpenID 审批", async () => {
  const replies = await run("#QQBot同意入群 REQ_1")
  assert.deepEqual(calls.at(-1), ["set", "OPENID", "REQ_1", true])
  assert.deepEqual(replies, ["已同意 珂(10001) 的入群申请"])
  assert.equal(notify.getRememberedRequest("REQ_1"), undefined, "处理后不再记着")
})

await test("没记下的申请从接口查；只有一条时可以不填 ID", async () => {
  list = [{ flag: "REQ_2", member_openid: "OPENID_2", user_id: "OPENID_2", nickname: "乙", comment: "" }]
  const replies = await run("#QQBot拒绝入群")
  assert.deepEqual(calls.at(-1), ["set", "OPENID_2", "REQ_2", false])
  assert.deepEqual(replies, ["已拒绝 乙(OPENID_2) 的入群申请"])

  list = []
  assert.deepEqual(await run("#QQBot同意入群 NOPE"), ["没有找到这条入群申请，可能已经处理过了"])
})

await test("#QQBot入群申请 列出申请并带按钮，接口报错时给出原因", async () => {
  list = [{ flag: "REQ_3", member_openid: "O3", user_id: "O3", nickname: "丙", comment: "我是新人" }]
  const replies = await run("#QQBot入群申请")
  assert.equal(replies[0][0], "【入群申请】丙(O3) 申请加入本群\n我是新人")
  assert.equal(replies[0][1].data[0][0].callback, "#QQBot同意入群 REQ_3")

  list = []
  assert.deepEqual(await run("#QQBot入群申请"), ["本群没有待处理的入群申请"])

  listError = Object.assign(new Error("no permission"), { code: 11253 })
  assert.deepEqual(await run("#QQBot入群申请"), ["查询入群申请失败：no permission（错误码 11253）"])
  listError = undefined
})

await test("非官方机器人不处理命令，私聊提示在群里使用", async () => {
  const wild = { ...event("#QQBot入群申请"), bot: { adapter: { id: "OneBotv11" } } }
  assert.deepEqual(await run("#QQBot入群申请", wild), [])
  const priv = { ...event("#QQBot入群申请"), group_id: undefined }
  assert.deepEqual(await run("#QQBot入群申请", priv), ["请在申请的群里使用"])
})

/* ---------- 野生号：引用回复确认 ---------- */

const wildSent = []
const approvals = []
const wildBot = {
  pickGroup: gid => ({ sendMsg: async msg => { wildSent.push([gid, msg]); return { message_id: 555 } } }),
  pickFriend: () => ({ getInfo: async () => ({ nickname: "珂" }) }),
}
const wildRequest = extra => ({
  self_id: "wild1",
  bot: wildBot,
  post_type: "request",
  request_type: "group",
  sub_type: "add",
  group_id: 654321,
  user_id: 30001,
  comment: "问题：Wath's your name?\n答案：珂",
  flag: "FLAG_1",
  approve: async value => { approvals.push(value); return true },
  ...extra,
})
const quoteReply = (text, { self_id = "wild1", user_id = 20000, quote } = {}) => {
  const replies = []
  const e = {
    self_id,
    user_id,
    group_id: 654321,
    message: [...(quote ? [{ type: "reply", id: quote }] : []), { type: "text", text }],
    reply: async msg => replies.push(msg),
  }
  return { e, replies }
}

await test("野生号收到申请：发提示（不带按钮），引用回复「同意」后通过", async () => {
  await emit("request.group.add", wildRequest())
  assert.deepEqual(wildSent.at(-1), [654321, "【入群申请】珂(30001) 申请加入本群\n问题：Wath's your name?\n答案：珂\n主人引用回复这条消息「同意」或「拒绝」"])

  // 非主人回复、没引用提示、文字不对：都不处理
  await emit("message.group", quoteReply("同意", { user_id: 40000, quote: 555 }).e)
  await emit("message.group", quoteReply("同意").e)
  await emit("message.group", quoteReply("同意吧", { quote: 555 }).e)
  assert.deepEqual(approvals, [])

  const { e, replies } = quoteReply("同意", { quote: 555 })
  await emit("message.group", e)
  assert.deepEqual(approvals, [true])
  assert.deepEqual(replies, ["已同意 珂(30001) 的入群申请"])

  // 处理了申请的消息不再交给其他插件，其他消息照常
  loader.deal(e)
  const other = quoteReply("同意吧", { quote: 555 }).e
  loader.deal(other)
  assert.deepEqual(dealt, [other])

  // 同一条回复官方机器人也收到了（引用是官方的 source.seq），不重复处理
  const again = quoteReply("同意", { self_id: "bot1", quote: 555 })
  await emit("message.group", again.e)
  assert.deepEqual(approvals, [true])
  assert.deepEqual(again.replies, [])
})

await test("引用回复「拒绝」；没有 e.approve 时调用 set_group_add_request", async () => {
  const api = []
  const bot = { ...wildBot, sendApi: async (...args) => { api.push(args); return {} } }
  await emit("request.group.add", wildRequest({ user_id: 30002, flag: "FLAG_2", approve: undefined, bot }))
  await emit("message.group", quoteReply("#拒绝", { quote: 555 }).e)
  assert.deepEqual(api, [["set_group_add_request", { flag: "FLAG_2", sub_type: "add", approve: false }]])
})

await test("官方机器人的提示也能引用回复；同一个人的申请只提示一次", async () => {
  const sent = []
  await notify.notifyJoinRequest({
    self_id: "bot1", group_id: "777", user_id: "50001", _raw_user_id: "OPENID_5", flag: "REQ_5", sub_type: "add",
    reply: async msg => { sent.push(msg); return { message_id: ["OFFICIAL_MSG_5"] } },
  })
  // 野生号随后收到同一个人的申请，不再提示
  const before = wildSent.length
  await emit("request.group.add", wildRequest({ group_id: "777", user_id: "50001", flag: "FLAG_5" }))
  assert.equal(wildSent.length, before)

  const { e, replies } = quoteReply("拒绝", { self_id: "bot1" })
  e.source = { seq: "OFFICIAL_MSG_5" }
  await emit("message.group", e)
  assert.deepEqual(calls.at(-1), ["set", "OPENID_5", "REQ_5", false])
  assert.deepEqual(replies, ["已拒绝 50001 的入群申请"])
})

await test("野生号的 invite（邀请机器人进群）不提示，关闭配置后不提示", async () => {
  const before = wildSent.length
  await emit("request.group.add", wildRequest({ sub_type: "invite", user_id: 30003, flag: "FLAG_3" }))
  config.joinRequestNotify = false
  await emit("request.group.add", wildRequest({ user_id: 30004, flag: "FLAG_4" }))
  delete config.joinRequestNotify
  assert.equal(wildSent.length, before)
})
