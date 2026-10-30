import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mock, test } from "node:test"

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
const adapter = {
  config: { messageRetentionDays: 0 },
  getGroupInfo: async data => ({ group_id: data.group_id, group_name: "测试群" }),
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
})

await fs.rm(root, { recursive: true, force: true })

// 开关命令
const config = {}
let saved = 0
mock.module(new URL("../../../lib/plugins/plugin.js", import.meta.url).href, {
  defaultExport: class {
    constructor (options) { Object.assign(this, options) }
  },
})
mock.module(new URL("../lib/config.js", import.meta.url).href, {
  namedExports: { config, configSave: async () => { saved++ } },
})
const { MessageFilterPlugin } = await import("../app/messageFilter.js")

await test("开关命令修改并保存配置", async () => {
  const app = new MessageFilterPlugin()
  const replies = []
  app.reply = msg => replies.push(msg)
  const run = msg => {
    const rule = app.rule.find(r => r.reg.test(msg))
    assert.ok(rule, msg)
    return app[rule.fnc]({ msg })
  }

  await run("#QQBot开启bot消息过滤")
  assert.equal(config.filterBotMsg, true)
  await run("#关闭机器人过滤")
  assert.equal(config.filterBotMsg, false)
  await run("#开启纯艾特其他机器人过滤")
  assert.equal(config.filterOnlyAtOtherBot, true)
  await run("#qqbot关闭纯AT其他BOT过滤")
  assert.equal(config.filterOnlyAtOtherBot, false)
  assert.equal(saved, 4)
  assert.match(replies[0], /已开启bot 消息过滤/)
  assert.ok(app.rule.every(r => r.permission === "master"))
})
