import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/joinRequestNotify.test.js
// 入群申请提示：群里发提示和主人专用按钮，#QQBot入群申请 / #QQBot同意入群 / #QQBot拒绝入群
global.Bot = { makeLog () {} }

const notify = await import("../lib/joinRequestNotify.js")

await test("提示文字带申请人和验证信息，按钮只允许主人点且指令写进按钮", async () => {
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
    reply: async msg => sent.push(msg),
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
  await notify.notifyJoinRequest({ flag: "REQ_ERR", reply: async () => { throw new Error("no") } })
})

// 命令
mock.module(new URL("../../../lib/plugins/plugin.js", import.meta.url).href, {
  defaultExport: class {
    constructor (options) { Object.assign(this, options) }
  },
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

await test("非官方机器人不处理，私聊提示在群里使用", async () => {
  const wild = { ...event("#QQBot入群申请"), bot: { adapter: { id: "OneBotv11" } } }
  assert.deepEqual(await run("#QQBot入群申请", wild), [])
  const priv = { ...event("#QQBot入群申请"), group_id: undefined }
  assert.deepEqual(await run("#QQBot入群申请", priv), ["请在申请的群里使用"])
})
