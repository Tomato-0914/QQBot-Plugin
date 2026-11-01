import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/messageFilter.test.js
// 机器人消息过滤：其他机器人的消息、只 @ 其他机器人的群消息
const { filterReason } = await import("../lib/messageFilter.js")

const group = { message_type: "group", sender: {} }
const selfAt = { id: "SELF", bot: true, is_you: true, scope: "single" }
const otherBotAt = { id: "OTHER_BOT", bot: true, is_you: false, scope: "single" }
const userAt = { id: "USER", bot: false, scope: "single" }

await test("默认不过滤", () => {
  assert.equal(filterReason({}, group, { author: { bot: true }, mentions: [otherBotAt] }), "")
})

await test("filterBotMsg 过滤其他机器人发的消息", () => {
  const config = { filterBotMsg: true }
  assert.equal(filterReason(config, group, { author: { bot: true } }), "其他机器人的消息")
  assert.equal(filterReason(config, { ...group, sender: { bot: "true" } }, {}), "其他机器人的消息")
  assert.equal(filterReason(config, group, { author: { bot: false } }), "")
})

await test("filterOnlyAtOtherBot 只过滤 @ 了其他机器人、没 @ 我的群消息", () => {
  const config = { filterOnlyAtOtherBot: true }
  assert.equal(filterReason(config, group, { mentions: [otherBotAt] }), "只 @ 了其他机器人")
  assert.equal(filterReason(config, group, { mentions: [otherBotAt, userAt] }), "只 @ 了其他机器人")
  assert.equal(filterReason(config, group, { mentions: [selfAt, otherBotAt] }), "", "同时 @ 了我")
  assert.equal(filterReason(config, group, { mentions: [userAt] }), "", "只 @ 了群友")
  assert.equal(filterReason(config, group, { mentions: [{ scope: "all", bot: true }] }), "", "@全体成员")
  assert.equal(filterReason(config, group, {}), "")
  assert.equal(filterReason(config, { message_type: "private" }, { mentions: [otherBotAt] }), "", "私聊不看")
})

// makeMessage：被过滤的消息不下发
const emitted = []
let groupInfoCalls = 0
const adapter = {
  config: { messageRetentionDays: 0 },
  getGroupInfo: async data => {
    groupInfoCalls++
    return { group_id: data.group_id, group_name: "测试群" }
  },
  setGroupMap: async () => {},
  sendGroupMsg: async () => {},
}
global.Bot = {
  10000: { uin: "10000", info: { id: "10000", appid: "appid" }, adapter },
  em: (name, data) => emitted.push(data),
  makeLog: () => {},
}
const { setMessageStoreRoot } = await import("../lib/messageStore.js")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-message-filter-"))
setMessageStoreRoot(root)
const { makeMessage } = await import("../lib/messageBuilder.js")

const groupMessage = (id, extra) => ({
  id,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  group_id: "GROUP_OPENID",
  raw_message: "你好",
  message: [{ type: "text", data: { text: "你好" } }],
  sender: { user_id: "USER_OPENID" },
  timestamp: 1,
  ...extra,
})

await test("makeMessage 丢弃被过滤的消息，其他消息照常下发", async () => {
  adapter.config.filterBotMsg = true
  adapter.config.filterOnlyAtOtherBot = true
  await makeMessage(adapter, "10000", groupMessage("m1", { author: { bot: true } }))
  await makeMessage(adapter, "10000", groupMessage("m2", { mentions: [otherBotAt] }))
  await makeMessage(adapter, "10000", groupMessage("m3", { author: { bot: false } }))
  assert.deepEqual(emitted.map(e => e.message_id), ["m3"])
  // 被过滤的消息不查群信息、不写聊天记录
  assert.equal(groupInfoCalls, 1)
  const files = await fs.readdir(path.join(root, "10000", "messages", "groups", "GROUP_OPENID"))
  const lines = (await fs.readFile(path.join(root, "10000", "messages", "groups", "GROUP_OPENID", files[0]), "utf8")).trim().split("\n")
  assert.deepEqual(lines.map(line => JSON.parse(line).message_id), ["m3"])
})

await fs.rm(root, { recursive: true, force: true })
