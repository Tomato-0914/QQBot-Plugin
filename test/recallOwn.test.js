import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/recallOwn.test.js
// 官方机器人只能撤回自己发的消息：Yunzai 的 recallMsg 连同触发指令的消息一起撤回时，跳过群友 / 好友发的消息
const logs = []
global.Bot = { makeLog: (level, msg) => logs.push([level, msg]) }

const incoming = new Set(["user-msg"])
const marked = []
mock.module(new URL("../lib/messageStore.js", import.meta.url).href, {
  namedExports: {
    isIncomingMsg: async (_bot, id, scope) => incoming.has(id) && !!scope,
    markMsgRecordRecalled: async (_bot, id, scope) => marked.push([id, scope]),
    saveMsgRecord: async () => {},
  },
})
mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: {
    translateToOpenid: async (_bot, id) => `openid-${id}`,
    getAppid: () => "app",
    getMappedUin: async () => false,
  },
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: {
    translateGroupToOpenid: async (_bot, id) => `group-${id}`,
    getGroupUin: async () => false,
  },
})

const { installMessageSender } = await import("../lib/messageSender.js")
const adapter = { sep: ":", config: {} }
installMessageSender(adapter)

const sdkCalls = []
const bot = {
  sdk: {
    recallGroupMessage: async (group, id) => sdkCalls.push(["group", group, id]),
    recallFriendMessage: async (user, id) => sdkCalls.push(["friend", user, id]),
  },
}

test("群聊：只撤回官方机器人自己的消息，群友的消息跳过且不请求接口", async () => {
  const rets = await adapter.recallGroupMsg({ self_id: "official", bot, group_id: "123456" }, ["bot-msg", "user-msg"])
  assert.deepEqual(sdkCalls, [["group", "group-123456", "bot-msg"]])
  assert.equal(rets.length, 2)
  assert.equal(rets[1], false)
  assert.deepEqual(marked, [["bot-msg", { groupOpenId: "group-123456" }]])
  assert.ok(logs.some(([level, msg]) => level === "debug" && /跳过撤回/.test(msg[0])))
  assert.ok(!logs.some(([, msg]) => Array.isArray(msg) && msg[0] === "撤回消息错误"))
})

test("私聊：好友发的消息同样跳过；单个 message_id 也能处理", async () => {
  sdkCalls.length = 0
  marked.length = 0
  assert.deepEqual(await adapter.recallFriendMsg({ self_id: "official", bot, user_id: "20001" }, "user-msg"), [false])
  await adapter.recallFriendMsg({ self_id: "official", bot, user_id: "20001" }, "bot-msg")
  assert.deepEqual(sdkCalls, [["friend", "openid-20001", "bot-msg"]])
  assert.deepEqual(marked, [["bot-msg", { userOpenId: "openid-20001" }]])
})
