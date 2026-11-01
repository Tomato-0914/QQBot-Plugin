import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/botNotice.test.js
// 机器人入群 / 退群、开关主动消息接收的通知，以及 Bot[id].info 不带密钥
const { EventParserMap, QQEvent } = await import("qq-official-bot")

const sdkBot = { logger: { info () {} } }
const parse = (type, name, payload) => EventParserMap.get(QQEvent[type]).call(sdkBot, name, payload)

mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: {
    applyUinMapping: async () => {},
    getAppid: () => "appid",
    getMappedUin: async (_appid, openid) => ({ OP_OPENID: "10001", USER_OPENID: "10002" })[openid],
  },
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: { getGroupUin: async (_bot, openid) => (openid === "GROUP_OPENID" ? "123456" : undefined) },
})
mock.module(new URL("../lib/messageBuilder.js", import.meta.url).href, { namedExports: { makeMessage: async () => {} } })
mock.module(new URL("../lib/messageStore.js", import.meta.url).href, { namedExports: { getRecordByMsgId: async () => undefined } })
mock.module(new URL("../lib/streamMessage.js", import.meta.url).href, { namedExports: { makeStreamReplyPayload: p => p } })

const emitted = []
const sent = []
const gl = new Map([["123456", { group_id: "123456", group_name: "旧群" }]])
const gml = new Map([["123456", new Map()]])
global.Bot = Object.assign(Object.create(null), {
  makeLog () {},
  em: (name, data) => emitted.push([name, data]),
  bot1: { gl, gml },
})
const adapter = {
  sendGroupMsg: async (...args) => { sent.push(["group", ...args]); return { message_id: ["m"] } },
  sendFriendMsg: async (...args) => { sent.push(["friend", ...args]); return { message_id: ["m"] } },
}
const { makeBotGroupNotice, makeReceiveNotice } = await import("../lib/client.js")

await test("机器人被拉进群：notice.group.increase，user_id 为机器人自己，可用 event_id 回复", async () => {
  emitted.length = sent.length = 0
  gl.delete("123456")
  const event = parse("GROUP_ADD_ROBOT", "notice.group.increase", {
    event_id: "GROUP_ADD_ROBOT:1", group_openid: "GROUP_OPENID", op_member_openid: "OP_OPENID", timestamp: 1700000000,
  })
  const data = await makeBotGroupNotice(adapter, "bot1", event)
  assert.equal(emitted.at(-1)[0], "notice.group.increase")
  assert.equal(data.user_id, "bot1")
  assert.equal(data.group_id, "123456")
  assert.equal(data._raw_group_id, "GROUP_OPENID")
  assert.equal(data.operator_id, "10001")
  assert.equal(data.message_id, "event_GROUP_ADD_ROBOT:1")
  assert.deepEqual(gl.get("123456"), { group_id: "123456", _raw_group_id: "GROUP_OPENID" })

  await data.reply("大家好")
  assert.equal(sent[0][1].group_id, "GROUP_OPENID")
  assert.equal(sent[0][1].message_id, "event_GROUP_ADD_ROBOT:1")
  assert.equal(sent[0][1].raw.event_id, "GROUP_ADD_ROBOT:1")
})

await test("机器人被移出群：notice.group.decrease，清掉群列表，不能再回复", async () => {
  emitted.length = sent.length = 0
  const event = parse("GROUP_DEL_ROBOT", "notice.group.decrease", {
    event_id: "GROUP_DEL_ROBOT:1", group_openid: "GROUP_OPENID", op_member_openid: "OP_OPENID", timestamp: 1700000000,
  })
  const data = await makeBotGroupNotice(adapter, "bot1", event)
  assert.equal(emitted.at(-1)[0], "notice.group.decrease")
  assert.equal(data.user_id, "bot1")
  assert.equal(gl.has("123456"), false)
  assert.equal(gml.has("123456"), false)
  assert.equal(await data.reply("再见"), false)
  assert.equal(sent.length, 0)
})

await test("群开关主动消息接收：notice.group.receive_open / receive_close，记录在群列表上", async () => {
  emitted.length = sent.length = 0
  gl.set("123456", { group_id: "123456" })
  const open = await makeReceiveNotice(adapter, "bot1", parse("GROUP_MSG_RECEIVE", "notice.group.receive_open", {
    event_id: "GROUP_MSG_RECEIVE:1", group_openid: "GROUP_OPENID", op_member_openid: "OP_OPENID", timestamp: 1700000000,
  }))
  assert.equal(emitted.at(-1)[0], "notice.group.receive_open")
  assert.equal(open.allow_proactive_msg, true)
  assert.equal(open.group_id, "123456")
  assert.equal(open.operator_id, "10001")
  assert.equal(gl.get("123456").allow_proactive_msg, true)
  await open.reply("已恢复")
  assert.equal(sent[0][1].message_id, "event_GROUP_MSG_RECEIVE:1")

  const close = await makeReceiveNotice(adapter, "bot1", parse("GROUP_MSG_REJECT", "notice.group.receive_close", {
    event_id: "GROUP_MSG_REJECT:1", group_openid: "GROUP_OPENID", op_member_openid: "OP_OPENID", timestamp: 1700000000,
  }))
  assert.equal(emitted.at(-1)[0], "notice.group.receive_close")
  assert.equal(close.allow_proactive_msg, false)
  assert.equal(gl.get("123456").allow_proactive_msg, false)
  assert.equal(await close.reply("x"), false)
  assert.equal(sent.length, 1)
})

await test("私聊开关主动消息接收：notice.friend.receive_open / receive_close", async () => {
  emitted.length = sent.length = 0
  const open = await makeReceiveNotice(adapter, "bot1", parse("C2C_MSG_RECEIVE", "notice.friend.receive_open", {
    event_id: "C2C_MSG_RECEIVE:1", openid: "USER_OPENID", timestamp: 1700000000,
  }))
  assert.equal(emitted.at(-1)[0], "notice.friend.receive_open")
  assert.equal(open.user_id, "10002")
  await open.reply("你好")
  assert.equal(sent[0][0], "friend")
  assert.equal(sent[0][1].user_id, "USER_OPENID")

  const close = await makeReceiveNotice(adapter, "bot1", parse("C2C_MSG_REJECT", "notice.friend.receive_close", {
    event_id: "C2C_MSG_REJECT:1", openid: "USER_OPENID", timestamp: 1700000000,
  }))
  assert.equal(emitted.at(-1)[0], "notice.friend.receive_close")
  assert.equal(close.allow_proactive_msg, false)
})

await test("Bot[id].info 不带 token、secret", async () => {
  const fs = await import("node:fs/promises")
  const source = await fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8")
  const info = source.match(/info: \{([\s\S]*?)\n {4}\},/)[1]
  assert.doesNotMatch(info, /\.\.\.opts|token|secret/)
  assert.match(info, /appid: opts\.appid/)
})
