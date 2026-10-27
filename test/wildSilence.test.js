import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/wildSilence.test.js
// 野生号静默：静默群里野生号收到的消息不进入任何插件
global.logger = new Proxy({}, { get: () => () => {} })

const dealt = []
const loader = {
  deal (e) { dealt.push(e) },
  setLimit () {},
}
mock.module(new URL("../../../lib/plugins/plugin.js", import.meta.url).href, {
  defaultExport: class {},
})
mock.module(new URL("../../../lib/plugins/loader.js", import.meta.url).href, {
  defaultExport: loader,
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: { getGroupUin: async () => undefined, translateGroupToOpenid: async () => undefined },
})

global.Bot = {
  uin: ["official", "wild"],
  official: { adapter: { id: "QQBot", name: "QQBot" } },
  wild: { adapter: { id: "QQ", name: "OneBotv11" } },
  adapter: [
    { id: "QQ", name: "OneBotv11", sendGroupMsg () {}, sendGroupForwardMsg () {} },
    { id: "QQBot", name: "QQBot", sendGroupMsg () {} },
  ],
}

const { silenceConfig } = await import("../lib/wildSilence.js")
await import("../app/wildSilence.js")
Object.assign(silenceConfig, { enable: true, groups: [123456], wild: [] })

const groupMessage = (self_id, group_id = 123456) =>
  ({ post_type: "message", message_type: "group", self_id, group_id })

await test("静默群里野生号的群消息在 loader.deal 入口丢弃，不进入任何插件", () => {
  dealt.length = 0
  loader.deal(groupMessage("wild"))
  assert.deepEqual(dealt, [])
})

await test("官方机器人、未静默的群、私聊和通知事件照常处理", () => {
  dealt.length = 0
  const events = [
    groupMessage("official"),
    groupMessage("wild", 654321),
    { post_type: "message", message_type: "private", self_id: "wild", user_id: 1 },
    { post_type: "notice", notice_type: "group", self_id: "wild", group_id: 123456 },
  ]
  for (const e of events) loader.deal(e)
  assert.deepEqual(dealt, events)
})

await test("关闭总开关后野生号的消息照常处理", () => {
  dealt.length = 0
  silenceConfig.enable = false
  loader.deal(groupMessage("wild"))
  assert.equal(dealt.length, 1)
  silenceConfig.enable = true
})
