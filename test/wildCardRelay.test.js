import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/wildCardRelay.test.js
// 野生号辅助：官方机器人发不了的内容、整条发送失败的消息交给野生号
global.logger = new Proxy({}, { get: () => (...args) => args[0] })
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: {
    getGroupUin: async (_bot, openid) => (openid === "group-openid" ? "123456" : false),
  },
})
mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: {
    getAppid: () => "app",
    getMappedUin: async (_appid, openid) => ({ "user-openid": "20001", "at-openid": "30003" })[openid] || false,
    isQQUin: value => /^\d{5,12}$/.test(String(value || "")),
  },
})

const { silenceConfig } = await import("../lib/wildSilence.js")
const { makeWildRelay, relaying, assistWild } = await import("../lib/wildCardRelay.js")

const wildSent = []
let wildRet = { message_id: ["wild-1"] }
const wildSend = (to, msg) => {
  wildSent.push({ to, msg, relaying: relaying.getStore() })
  if (wildRet instanceof Error) throw wildRet
  return wildRet
}
global.Bot = {
  uin: ["official", "wild"],
  official: { adapter: { id: "QQBot", name: "QQBot" } },
  wild: {
    uin: "wild",
    adapter: { id: "QQ", name: "OneBotv11" },
    gl: new Map([[123456, {}]]),
    fl: new Map([[20001, {}]]),
    pickGroup: gid => ({ sendMsg: async msg => wildSend(`group:${gid}`, msg) }),
    pickFriend: uid => ({ sendMsg: async msg => wildSend(`friend:${uid}`, msg) }),
  },
}

const officialSent = []
let officialRet = { message_id: ["official-1"] }
const adapter = { sep: ":" }
const officialSend = async (_data, msg) => {
  officialSent.push(msg)
  if (officialRet instanceof Error) throw officialRet
  return officialRet
}
const relay = makeWildRelay(adapter, officialSend)
const friendRelay = makeWildRelay(adapter, officialSend, "friend")
const data = { self_id: "official", group_id: "official:group-openid" }
const card = { type: "json", data: { app: "com.tencent.structmsg" } }
const music = { type: "music", data: { type: "custom", title: "一丝不挂" } }
const file = { type: "file", file: "/tmp/a.zip", name: "a.zip" }

function reset ({ groups = [123456], ret = { message_id: ["wild-1"] }, official = { message_id: ["official-1"] } } = {}) {
  Object.assign(silenceConfig, { enable: true, groups, wild: [], assist: true })
  wildSent.length = 0
  officialSent.length = 0
  wildRet = ret
  officialRet = official
}

await test("卡片改由野生号发送", async () => {
  reset()
  const ret = await relay(data, music)
  assert.deepEqual(wildSent, [{ to: "group:123456", msg: music, relaying: true }])
  assert.deepEqual(officialSent, [])
  assert.deepEqual(ret, { message_id: ["wild-1"] })
})

await test("卡片和文字混发时，文字仍由官方机器人发送", async () => {
  reset()
  await relay({ ...data, group_id: "123456" }, [{ type: "reply", id: "m1" }, card, "文字"])
  assert.deepEqual(wildSent.map(i => i.msg), [card])
  assert.deepEqual(officialSent, [[{ type: "reply", id: "m1" }, "文字"]])
})

await test("合并转发、戳一戳交给野生号；文件官方机器人能发，照常由官方机器人发送", async () => {
  reset()
  const forward = { type: "node", data: [{ message: "第一条" }, { message: "第二条" }] }
  const poke = { type: "poke", qq: 10001 }
  await relay(data, forward)
  await relay(data, [file, "文件说明"])
  await relay(data, poke)
  assert.deepEqual(wildSent.map(i => i.msg), [forward, poke])
  assert.deepEqual(officialSent, [[file, "文件说明"]])

  // 官方机器人发文件失败时，整条交给野生号
  reset({ official: { message_id: [], error: [new Error("文件上传失败")] } })
  await relay(data, file)
  assert.deepEqual(wildSent.map(i => i.msg), [[file]])
})

await test("不限静默群：野生号在群里就会辅助；没有群绑定、野生号不在群、关闭辅助时不转交", async () => {
  reset({ groups: [654321] })
  assert.ok(assistWild(123456))
  await relay(data, card)
  assert.deepEqual(wildSent.map(i => i.msg), [card])

  reset()
  await relay(data, "文字")
  await relay({ ...data, group_id: "official:unknown-openid" }, card)
  await relay({ ...data, group_id: "654321" }, card)
  silenceConfig.assist = false
  await relay(data, card)
  assert.deepEqual(wildSent, [])
  assert.deepEqual(officialSent, ["文字", card, card, card])
})

await test("野生号发送失败或被拦截时交回官方机器人", async () => {
  reset({ ret: new Error("timeout") })
  await relay(data, [card, "文字"])
  reset({ ret: { message_id: [], error: [] } })
  await relay(data, card)
  assert.deepEqual(officialSent, [[card]])
})

await test("官方机器人整条发送失败时改由野生号发送：去掉官方专用的部分，Markdown 转文字，@ 换成 QQ 号", async () => {
  reset({ official: { message_id: [], error: [new Error("主动消息额度已用完")] } })
  const ret = await relay(data, [
    { type: "reply", id: "m1" },
    { type: "at", qq: "at-openid" },
    { type: "markdown", data: "**今日运势**" },
    { type: "button", data: [] },
    "大吉",
  ])
  assert.deepEqual(ret, { message_id: ["wild-1"] })
  assert.deepEqual(wildSent.map(i => i.msg), [[{ type: "at", qq: "30003" }, "**今日运势**", "大吉"]])

  reset({ official: new Error("被动回复已过期") })
  assert.deepEqual(await relay(data, "文字"), { message_id: ["wild-1"] })
  assert.deepEqual(wildSent.map(i => i.msg), [["文字"]])
})

await test("官方机器人和野生号都发送失败时，保留官方机器人的结果或错误", async () => {
  const failed = { message_id: [], error: [new Error("官方失败")] }
  reset({ official: failed, ret: new Error("野生号失败") })
  assert.equal(await relay(data, "文字"), failed)

  reset({ official: new Error("官方失败"), ret: { message_id: [] } })
  await assert.rejects(relay(data, "文字"), /官方失败/)

  // 野生号已经发失败的卡片，官方机器人也失败后不再重复交给野生号
  reset({ official: failed, ret: new Error("野生号失败") })
  await relay(data, [card, "文字"])
  assert.deepEqual(wildSent.map(i => i.msg), [card, ["文字"]])
})

await test("私聊：与对方是好友的野生号代发卡片，整条失败时也由它发送", async () => {
  reset()
  const friend = { self_id: "official", user_id: "user-openid" }
  await friendRelay(friend, [card, "说明"])
  assert.deepEqual(wildSent.map(i => [i.to, i.msg]), [["friend:20001", card]])
  assert.deepEqual(officialSent, [["说明"]])

  reset({ official: new Error("失败") })
  await friendRelay({ self_id: "official", user_id: "20001" }, "你好")
  assert.deepEqual(wildSent.map(i => [i.to, i.msg]), [["friend:20001", ["你好"]]])

  // 不是野生号的好友、或没有绑定 QQ 号时不转交
  reset()
  await friendRelay({ self_id: "official", user_id: "unknown-openid" }, card)
  await friendRelay({ self_id: "official", user_id: "99999" }, card)
  assert.deepEqual(wildSent, [])
  assert.deepEqual(officialSent, [card, card])
})

await test("野生号替官方机器人发送期间不再转交，避免来回转发", async () => {
  reset({ official: new Error("失败") })
  await assert.rejects(relaying.run(true, () => relay(data, card)))
  assert.deepEqual(wildSent, [])
  assert.deepEqual(officialSent, [card])
})
