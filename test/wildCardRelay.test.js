import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/wildCardRelay.test.js
// 野生号静默：静默群里官方机器人发不了的卡片交给同群的野生号
global.logger = new Proxy({}, { get: () => (...args) => args[0] })
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: {
    getGroupUin: async (_bot, openid) => (openid === "group-openid" ? "123456" : false),
  },
})

const { silenceConfig } = await import("../lib/wildSilence.js")
const { makeCardRelay, relaying } = await import("../lib/wildCardRelay.js")

const wildSent = []
let wildRet = { message_id: ["wild-1"] }
global.Bot = {
  uin: ["official", "wild"],
  official: { adapter: { id: "QQBot", name: "QQBot" } },
  wild: {
    uin: "wild",
    adapter: { id: "QQ", name: "OneBotv11" },
    gl: new Map([[123456, {}]]),
    pickGroup: gid => ({
      sendMsg: async msg => {
        wildSent.push({ gid, msg, relaying: relaying.getStore() })
        if (wildRet instanceof Error) throw wildRet
        return wildRet
      },
    }),
  },
}

const officialSent = []
const adapter = { sep: ":" }
const relay = makeCardRelay(adapter, async (_data, msg) => {
  officialSent.push(msg)
  return { message_id: ["official-1"] }
})
const data = { self_id: "official", group_id: "official:group-openid" }
const card = { type: "json", data: { app: "com.tencent.structmsg" } }
const music = { type: "music", data: { type: "custom", title: "一丝不挂" } }

function reset (groups = [123456], ret = { message_id: ["wild-1"] }) {
  Object.assign(silenceConfig, { enable: true, groups, wild: [] })
  wildSent.length = 0
  officialSent.length = 0
  wildRet = ret
}

await test("静默群里的卡片改由野生号发送", async () => {
  reset()
  const ret = await relay(data, music)
  assert.deepEqual(wildSent, [{ gid: 123456, msg: music, relaying: true }])
  assert.deepEqual(officialSent, [])
  assert.deepEqual(ret, { message_id: ["wild-1"] })
})

await test("卡片和文字混发时，文字仍由官方机器人发送", async () => {
  reset()
  await relay({ ...data, group_id: "123456" }, [{ type: "reply", id: "m1" }, card, "文字"])
  assert.deepEqual(wildSent.map(i => i.msg), [card])
  assert.deepEqual(officialSent, [[{ type: "reply", id: "m1" }, "文字"]])
})

await test("合并转发里带卡片时整条转发交给野生号", async () => {
  reset()
  const forward = { type: "node", data: [{ message: "说明" }, { message: card }] }
  await relay(data, forward)
  assert.deepEqual(wildSent.map(i => i.msg), [forward])
  assert.deepEqual(officialSent, [])
})

await test("没有卡片、未静默或野生号不在群时不转交", async () => {
  reset()
  await relay(data, "文字")
  reset([654321])
  await relay(data, card)
  reset()
  await relay({ ...data, group_id: "official:unknown-openid" }, card)
  assert.deepEqual(wildSent, [])
  assert.deepEqual(officialSent, [card])
})

await test("野生号发送失败或被拦截时卡片仍由官方机器人发送", async () => {
  reset([123456], new Error("timeout"))
  await relay(data, [card, "文字"])
  reset([123456], { message_id: [], error: [] })
  await relay(data, card)
  assert.deepEqual(officialSent, [[card]])
})

await test("野生号替官方机器人发卡片期间不再转交，避免来回转发", async () => {
  reset()
  await relaying.run(true, () => relay(data, card))
  assert.deepEqual(wildSent, [])
  assert.deepEqual(officialSent, [card])
})
