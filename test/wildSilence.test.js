import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/wildSilence.test.js
// 野生号静默：静默群里野生号收到的消息不进入任何插件
global.logger = new Proxy({}, { get: () => () => {} })

const dealt = []
// 模拟插件处理消息：测试可通过 onDeal 在处理过程中发消息
let onDeal
const loader = {
  deal (e) {
    dealt.push(e)
    return onDeal?.(e)
  },
  setLimit () {},
}
mock.module(new URL("../../../lib/plugins/plugin.js", import.meta.url).href, {
  defaultExport: class {},
})
mock.module(new URL("../../../lib/plugins/loader.js", import.meta.url).href, {
  defaultExport: loader,
})
const openids = { 123456: "open-on", 222222: "open-off", 444444: "open-error" }
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: {
    getGroupUin: async () => undefined,
    translateGroupToOpenid: async (_bot, gid) => openids[gid],
  },
})

const officialSent = []
const wildSent = []
const wildForwards = []
global.Bot = {
  uin: ["official", "wild"],
  official: {
    adapter: { id: "QQBot", name: "QQBot" },
    pickGroup: gid => ({ sendMsg: async msg => { officialSent.push([gid, msg]); return { message_id: ["o1"] } } }),
    sdk: {
      getGroupBotState: async openid => {
        if (openid === "open-error") throw Object.assign(new Error("failed"), { code: 11253 })
        return { allow_proactive_msg: openid === "open-on" }
      },
    },
  },
  wild: {
    adapter: { id: "QQ", name: "OneBotv11" },
    gl: new Map([[123456, {}], [654321, {}]]),
    pickGroup () {},
  },
  adapter: [
    {
      id: "QQ",
      name: "OneBotv11",
      sendGroupMsg (data, msg) {
        wildSent.push([data.group_id, msg])
        return { message_id: ["w1"] }
      },
      sendGroupForwardMsg (data, msg) {
        wildForwards.push([data.group_id, msg])
        return { message_id: ["w2"] }
      },
    },
    { id: "QQBot", name: "QQBot", sendGroupMsg () {} },
  ],
}

const { silenceConfig } = await import("../lib/wildSilence.js")
const { WildSilencePlugin } = await import("../app/wildSilence.js")
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

await test("状态里显示每个静默群的主动消息开关", async () => {
  Object.assign(silenceConfig, { groups: [123456, 222222, 333333, 444444], cron: "official" })
  const replies = []
  const plugin = new WildSilencePlugin()
  assert.equal(await plugin.status({ self_id: "wild", isMaster: true, reply: async msg => replies.push(msg) }), true)
  assert.equal(replies.length, 1)
  assert.match(replies[0], /123456 主动消息：开启/)
  assert.match(replies[0], /222222 主动消息：关闭/)
  assert.match(replies[0], /333333 主动消息：未绑定群/)
  assert.match(replies[0], /444444 主动消息：查询失败（11253）/)
  assert.match(replies[0], /需群管理在机器人资料页开启/)
  silenceConfig.groups = [123456]
})

await test("管理命令：野生号收不到的地方由官方机器人处理，避免两边重复回复", () => {
  Object.assign(silenceConfig, { enable: true, groups: [123456] })
  const plugin = new WildSilencePlugin()
  const can = e => plugin.canManage({ isMaster: true, ...e })
  assert.equal(can({ self_id: "wild", isGroup: true, group_id: 654321 }), true)
  // 静默群：野生号的消息在入口丢弃，官方机器人接手
  assert.equal(can({ self_id: "official", isGroup: true, group_id: 123456 }), true)
  // 私聊和没有野生号的群
  assert.equal(can({ self_id: "official", isGroup: false }), true)
  assert.equal(can({ self_id: "official", isGroup: true, group_id: 999999 }), true)
  // 野生号正常处理的群里官方机器人不响应
  assert.equal(can({ self_id: "official", isGroup: true, group_id: 654321 }), false)
  // 只有主人能用
  assert.equal(can({ self_id: "official", isGroup: false, isMaster: false }), false)
})

await test("卡片消息：静默群里由野生号解析，官方机器人收到的同一张卡片跳过", () => {
  Object.assign(silenceConfig, { enable: true, groups: [123456] })
  dealt.length = 0
  const card = { ...groupMessage("wild"), message: [{ type: "json", data: '{"meta":{"detail_1":{"qqdocurl":"https://b23.tv/x"}}}' }] }
  loader.deal(card)
  assert.deepEqual(dealt, [card])
  assert.equal(card._wildCardParse, true)

  // 静默群里其他消息仍然丢弃
  dealt.length = 0
  loader.deal({ ...groupMessage("wild"), message: [{ type: "text", text: "你好" }] })
  assert.deepEqual(dealt, [])

  // 官方机器人：同群有静默野生号时跳过卡片；没有野生号的群、普通消息照常处理
  const officialCard = gid => ({ ...groupMessage("official", gid), raw: { ark_data: { fields: { title: "视频" } } } })
  loader.deal(officialCard(123456))
  assert.deepEqual(dealt, [])
  const kept = [officialCard(999999), groupMessage("official")]
  for (const e of kept) loader.deal(e)
  assert.deepEqual(dealt, kept)

  // accept / 规则拦截放行正在解析的卡片
  const plugin = new WildSilencePlugin()
  const e = { isGroup: true, self_id: "wild", group_id: 123456, _wildCardParse: true, reply: "原回复" }
  plugin.accept(e)
  assert.equal(e.reply, "原回复")
  assert.equal(plugin.check(e), false)
  assert.equal(plugin.check({ ...e, _wildCardParse: false }), true)
})

await test("卡片解析结果不看定时消息配置，始终先交给官方机器人发送", async () => {
  Object.assign(silenceConfig, { enable: true, groups: [123456], cron: "block" })
  officialSent.length = 0
  wildSent.length = 0
  const adapter = Bot.adapter[0]
  onDeal = async e => {
    await new Promise(resolve => setTimeout(resolve, 1))
    // 引用野生号消息 ID 的回复段官方机器人无法引用，转交时去掉
    return adapter.sendGroupMsg({ self_id: "wild", group_id: e.group_id }, [
      { type: "reply", id: "2146786680" },
      "解析好的视频",
    ])
  }
  try {
    await loader.deal({ ...groupMessage("wild"), message: [{ type: "xml", data: "<msg/>" }] })
    assert.deepEqual(officialSent, [["123456", ["解析好的视频"]]])
    assert.deepEqual(wildSent, [])

    // 不在解析卡片时，定时消息配置为“不发”的照旧拦截
    await adapter.sendGroupMsg({ self_id: "wild", group_id: 123456 }, "定时消息")
    assert.equal(officialSent.length, 1)
    assert.deepEqual(wildSent, [])
  } finally {
    onDeal = undefined
    silenceConfig.cron = "official"
  }
})

await test("静默群里野生号自己的合并转发由野生号直接发送，不再交给官方机器人拍平", async () => {
  Object.assign(silenceConfig, { enable: true, groups: [123456], cron: "official" })
  officialSent.length = 0
  const adapter = Bot.adapter[0]
  const ret = await adapter.sendGroupForwardMsg({ self_id: "wild", group_id: 123456 }, [{ message: "第一条" }])
  assert.deepEqual(ret, { message_id: ["w2"] })
  assert.deepEqual(wildForwards, [[123456, [{ message: "第一条" }]]])
  assert.deepEqual(officialSent, [])
})
