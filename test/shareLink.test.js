import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/shareLink.test.js
// 分享链接：POST /v2/generate_url_link；用户通过链接添加机器人时，好友新增事件带回 callback_data
// 先从包入口初始化 SDK，避免直接加载事件子模块触发其既有循环依赖。
const { Bot: SdkBot, EventParserMap, QQEvent } = await import("qq-official-bot")

await test("getGenerateUrl 以 callback_data 生成分享链接", async () => {
  const calls = []
  const sdk = Object.assign(Object.create(SdkBot.prototype), {
    request: {
      post: async (url, body) => {
        calls.push({ url, body })
        return { data: { data: { url: "https://qun.qq.com/qunpro/robot/share?robot_appid=1&callback_data=abc" } } }
      },
    },
  })
  assert.match(await sdk.getGenerateUrl("abc"), /callback_data=abc/)
  assert.deepEqual(calls.at(-1), { url: "/v2/generate_url_link", body: { callback_data: "abc" } })
  await assert.rejects(sdk.getGenerateUrl("x".repeat(33)), /最长 32 个字符/)
})

await test("好友新增事件保留添加来源", () => {
  const bot = { logger: { info () {} } }
  const event = EventParserMap.get(QQEvent.FRIEND_ADD).call(bot, "notice.friend.increase", {
    event_id: "EV", openid: "USER_OPENID", scene: 2004, scene_param: "abc", timestamp: 1700000000,
  })
  assert.equal(event.user_id, "USER_OPENID")
  assert.equal(event.scene, 2004)
  assert.equal(event.scene_param, "abc")
})

mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: {
    applyUinMapping: async () => {},
    getAppid: () => "appid",
    getMappedUin: async (_appid, openid) => (openid === "USER_OPENID" ? "10001" : undefined),
  },
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, { namedExports: { getGroupUin: async () => undefined } })
mock.module(new URL("../lib/messageBuilder.js", import.meta.url).href, { namedExports: { makeMessage: async () => {} } })
mock.module(new URL("../lib/messageStore.js", import.meta.url).href, { namedExports: { getRecordByMsgId: async () => undefined } })
mock.module(new URL("../lib/streamMessage.js", import.meta.url).href, { namedExports: { makeStreamReplyPayload: p => p } })

const emitted = []
const sent = []
global.Bot = Object.assign(Object.create(null), {
  makeLog () {},
  em: (name, data) => emitted.push([name, data]),
  bot1: {},
})
const adapter = { sendFriendMsg: async (...args) => sent.push(args) }
const { makeFriendNotice } = await import("../lib/client.js")

await test("通过分享链接添加好友：notice.friend.increase 带 callback_data，可用 event_id 回复", async () => {
  const data = await makeFriendNotice(adapter, "bot1", {
    sub_type: "increase", event_id: "EV", user_id: "USER_OPENID", scene: 2004, scene_param: "abc", time: 1,
  })
  assert.equal(emitted.at(-1)[0], "notice.friend.increase")
  assert.equal(data.user_id, "10001")
  assert.equal(data._raw_user_id, "USER_OPENID")
  assert.equal(data.callback_data, "abc")
  assert.equal(data.message_id, "event_EV")

  await data.reply("欢迎")
  assert.equal(sent.at(-1)[0].user_id, "USER_OPENID")
  assert.equal(sent.at(-1)[0].message_id, "event_EV")
})

await test("其他来源的好友新增没有 callback_data，好友减少不能回复", async () => {
  const added = await makeFriendNotice(adapter, "bot1", { sub_type: "increase", user_id: "OTHER", scene: 1003, scene_param: "x" })
  assert.equal(added.callback_data, "")
  assert.equal(added.scene_param, "x")
  assert.equal(added.user_id, "OTHER")

  const removed = await makeFriendNotice(adapter, "bot1", { sub_type: "decrease", user_id: "USER_OPENID" })
  assert.equal(emitted.at(-1)[0], "notice.friend.decrease")
  assert.equal(removed.reply, undefined)
  assert.equal(await makeFriendNotice(adapter, "bot1", { sub_type: "update", user_id: "USER_OPENID" }), false)
})
