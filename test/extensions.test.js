import assert from "node:assert/strict"
import { test } from "node:test"

// Run with: node --test test/extensions.test.js
// 适配器扩展接口：其他插件挂接发送流程、补充对象方法
global.Bot = { makeLog () {} }

const { installExtensions, mapping } = await import("../lib/extensions.js")

function makeAdapter () {
  const sent = []
  const adapter = {
    config: {},
    sendGroupMsg: async (data, msg) => {
      sent.push(["group", data, msg])
      return { message_id: ["g1"] }
    },
    sendFriendMsg: async (data, msg) => {
      sent.push(["friend", data, msg])
      return { message_id: ["f1"] }
    },
    pickFriend (id, user_id) {
      return { self_id: id, user_id, sendMsg: msg => this.sendFriendMsg({ user_id }, msg) }
    },
    pickMember (id, group_id, user_id) {
      return { ...this.pickFriend(id, user_id), group_id }
    },
    pickGroup (id, group_id) {
      return { self_id: id, group_id }
    },
  }
  installExtensions(adapter)
  return { adapter, sent }
}

const forward = [{ type: "node", data: [{ message: "思考过程" }, { message: "第一步" }] }]

test("没有扩展时直接发送，纯文字合并转发转成 Markdown", async () => {
  const { adapter, sent } = makeAdapter()
  assert.deepEqual(await adapter.sendGroupMsg({ group_id: "g" }, "你好"), { message_id: ["g1"] })
  await adapter.sendFriendMsg({ user_id: "u" }, forward)
  assert.equal(sent[0][2], "你好")
  assert.equal(sent[1][0], "friend")
  assert.equal(sent[1][2][0].type, "markdown")
})

test("forwardMarkdown: false 时合并转发原样交给扩展和适配器", async () => {
  const { adapter, sent } = makeAdapter()
  adapter.config.forwardMarkdown = false
  await adapter.sendGroupMsg({}, forward)
  assert.equal(sent[0][2], forward)
})

test("send 扩展按注册顺序执行，可以改写消息、拦截发送", async () => {
  const { adapter, sent } = makeAdapter()
  const seen = []
  adapter.use("a", {
    send (scope, data, msg, next) {
      seen.push(["a", scope, msg])
      return next(data, [].concat(msg, "+a"))
    },
  })
  adapter.use("b", {
    send (scope, data, msg, next) {
      seen.push(["b", scope, msg])
      if (scope === "friend") return { message_id: ["intercepted"] }
      return next()
    },
  })

  await adapter.sendGroupMsg({ group_id: "g" }, forward)
  // 扩展收到的已经是转换后的 Markdown
  assert.equal(seen[0][2][0].type, "markdown")
  assert.deepEqual(seen[1][2].at(-1), "+a")
  assert.deepEqual(sent[0][2].at(-1), "+a")

  assert.deepEqual(await adapter.sendFriendMsg({}, "hi"), { message_id: ["intercepted"] })
  assert.equal(sent.length, 1)
})

test("同名扩展替换旧的，unuse 和 use 的返回值都能移除", async () => {
  const { adapter, sent } = makeAdapter()
  let calls = 0
  adapter.use("x", { send: (_s, d, m, next) => { calls += 10; return next() } })
  const remove = adapter.use("x", { send: (_s, d, m, next) => { calls += 1; return next() } })
  await adapter.sendGroupMsg({}, "1")
  assert.equal(calls, 1)
  remove()
  await adapter.sendGroupMsg({}, "2")
  assert.equal(calls, 1)
  adapter.use("y", { send: () => ({ message_id: [] }) })
  adapter.unuse("y")
  await adapter.sendGroupMsg({}, "3")
  assert.equal(sent.length, 3)
})

test("pick 扩展可以给好友 / 群成员 / 群对象补方法，成员对象也带上好友的方法", async () => {
  const { adapter } = makeAdapter()
  const ctxs = []
  adapter.use("assist", {
    pick (kind, obj, ctx) {
      ctxs.push([kind, ctx])
      if (kind === "friend") obj.thumbUp = () => "like"
      if (kind === "member") obj.poke = () => "poke"
      if (kind === "group") return { ...obj, sign: () => "sign" }
    },
  })
  adapter.use("broken", { pick () { throw new Error("坏扩展") } })

  assert.equal(adapter.pickFriend("bot", "u1").thumbUp(), "like")
  const member = adapter.pickMember("bot", "g1", "u2")
  assert.equal(member.poke(), "poke")
  assert.equal(member.thumbUp(), "like")
  assert.equal(adapter.pickGroup("bot", "g1").sign(), "sign")
  assert.deepEqual(ctxs.find(([kind]) => kind === "member")[1], { self_id: "bot", group_id: "g1", user_id: "u2" })
  assert.deepEqual(ctxs.find(([kind]) => kind === "group")[1], { self_id: "bot", group_id: "g1" })
})

test("adapter.mapping 暴露映射与头像校验接口", () => {
  const { adapter } = makeAdapter()
  assert.equal(adapter.mapping, mapping)
  for (const name of [
    "getAppid", "isQQUin", "isGuildUserId", "getMappedUin", "getMappedOpenid", "saveMapping",
    "translateToOpenid", "getGroupUin", "translateGroupToOpenid", "saveGroupMapping", "checkAvatar",
  ])
    assert.equal(typeof mapping[name], "function", name)
  assert.equal(mapping.isQQUin("123456"), true)
})
