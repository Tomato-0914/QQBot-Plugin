import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/wildAssist.test.js
// 野生号代办：官方机器人没有的功能（点赞、发群文件、查成员资料等）交给野生号执行
global.logger = new Proxy({}, { get: () => () => {} })
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: { getGroupUin: async (_bot, openid) => (openid === "group-openid" ? "123456" : false) },
})
mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: {
    getAppid: () => "app",
    getMappedUin: async (_appid, openid) => ({ "user-openid": "20001" })[openid] || false,
    isQQUin: value => /^\d{5,12}$/.test(String(value || "")),
  },
})

const { silenceConfig } = await import("../lib/wildSilence.js")
const { installWildAssist } = await import("../lib/wildAssist.js")

const calls = []
const record = (who, name) => async (...args) => {
  calls.push([who, name, ...args])
  if (name === "getMemberMap") return new Map([[20001, { card: "番茄酱" }]])
  return { code: 0, who }
}
const methods = (who, names) => Object.fromEntries(names.map(n => [n, record(who, n)]))

let wildOnline = true
global.Bot = {
  get uin() {
    return wildOnline ? ["official", "wild"] : ["official"]
  },
  official: { adapter: { id: "QQBot", name: "QQBot" } },
  wild: {
    uin: "wild",
    adapter: { id: "QQ", name: "OneBotv11" },
    gl: new Map([[123456, {}]]),
    fl: new Map([[20001, {}]]),
    pickFriend: uid => methods(`friend:${uid}`, ["thumbUp", "sendFile", "sendForwardMsg", "getInfo"]),
    pickMember: (gid, uid) => methods(`member:${gid}:${uid}`, ["getInfo", "poke", "thumbUp"]),
    pickGroup: gid => methods(`group:${gid}`, [
      "sendFile", "getMemberMap", "getMemberList", "setCard", "setTitle", "pokeMember", "muteAll",
    ]),
  },
}

// 模拟官方机器人适配器：好友对象没有 thumbUp，群对象只有官方能做的方法
const officialAdapter = {
  sep: ":",
  pickFriend(id, user_id) {
    return { user_id, sendMsg: () => "official-send" }
  },
  pickMember(id, group_id, user_id) {
    return { ...this.pickFriend(id, user_id), group_id, mute: () => "official-mute" }
  },
  pickGroup(id, group_id) {
    return {
      group_id,
      sendMsg: () => "official-send",
      muteMember: () => "official-mute",
      getMemberMap: () => new Map([["seen", {}]]),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
    }
  },
}
installWildAssist(officialAdapter)

function reset() {
  calls.length = 0
  wildOnline = true
  silenceConfig.assist = true
  silenceConfig.wild = []
}

await test("好友点赞交给野生号：openid 换成 QQ 号，返回野生号的结果（椰奶点赞的调用方式）", async () => {
  reset()
  const friend = officialAdapter.pickFriend("official", "user-openid")
  assert.equal(typeof friend.thumbUp, "function")
  assert.deepEqual(await friend.thumbUp(10), { code: 0, who: "friend:20001" })
  assert.deepEqual(calls, [["friend:20001", "thumbUp", 10]])
  // 官方机器人原有的方法不受影响
  assert.equal(friend.sendMsg(), "official-send")
})

await test("群成员资料、戳一戳交给同群野生号；成员对象的 getInfo 是成员资料而不是好友资料", async () => {
  reset()
  const member = officialAdapter.pickGroup("official", "group-openid").pickMember("20001")
  await member.getInfo()
  await member.poke()
  await member.thumbUp(5)
  assert.deepEqual(calls, [
    ["member:123456:20001", "getInfo"],
    ["member:123456:20001", "poke"],
    ["friend:20001", "thumbUp", 5],
  ])
  assert.equal(member.mute(), "official-mute")
})

await test("群方法交给野生号，成员参数的 openid 换成 QQ 号", async () => {
  reset()
  const group = officialAdapter.pickGroup("official", "official:group-openid")
  await group.sendFile("/tmp/a.zip", "a.zip")
  await group.setCard("user-openid", "新名片")
  await group.setTitle(20001, "头衔")
  await group.pokeMember("user-openid")
  await group.muteAll(true)
  assert.deepEqual(calls, [
    ["group:123456", "sendFile", "/tmp/a.zip", "a.zip"],
    ["group:123456", "setCard", 20001, "新名片"],
    ["group:123456", "setTitle", 20001, "头衔"],
    ["group:123456", "pokeMember", 20001],
    ["group:123456", "muteAll", true],
  ])
  assert.equal(group.muteMember(), "official-mute")
})

await test("成员列表优先取野生号的完整列表，野生号不可用时用回官方机器人见过的成员", async () => {
  reset()
  const group = officialAdapter.pickGroup("official", "123456")
  assert.deepEqual([...(await group.getMemberMap()).keys()], [20001])
  wildOnline = false
  assert.deepEqual([...(await group.getMemberMap()).keys()], ["seen"])
})

await test("没有野生号、未绑定时给出明确的错误；关闭辅助时不补方法", async () => {
  reset()
  wildOnline = false
  await assert.rejects(officialAdapter.pickFriend("official", "20001").thumbUp(1), /没有在线的野生号/)
  await assert.rejects(officialAdapter.pickGroup("official", "123456").sendFile("a"), /野生号不在这个群/)
  wildOnline = true
  await assert.rejects(officialAdapter.pickFriend("official", "unknown-openid").thumbUp(1), /还没有绑定 QQ 号/)
  await assert.rejects(officialAdapter.pickGroup("official", "unknown-openid").sendFile("a"), /还没有群绑定/)

  silenceConfig.assist = false
  assert.equal(officialAdapter.pickFriend("official", "20001").thumbUp, undefined)
  assert.equal(typeof officialAdapter.pickGroup("official", "123456").getMemberMap(), "object")
})

await test("频道（qg_）对象不补方法；重复安装不会越包越多", async () => {
  reset()
  assert.equal(officialAdapter.pickFriend("official", "qg_123").thumbUp, undefined)
  installWildAssist(officialAdapter)
  await officialAdapter.pickFriend("official", "20001").thumbUp(1)
  assert.deepEqual(calls, [["friend:20001", "thumbUp", 1]])
})
