import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { setImmediate as nextTurn } from "node:timers/promises"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/sdkHostErrors.test.js
// Mock the SDK and all persistence/configuration boundaries; never load live bot data.
const logs = []
const messages = []
let startBot = async () => {}
let stopBot = async () => {}
let stopCalls = 0
let handleMessage = (...args) => { messages.push(args) }
let resolveAppid = bot => bot.info.appid
let saveMapping = async () => true

class MockSdk extends EventEmitter {
  receiver = new EventEmitter()
  start () { return startBot() }
  stop () {
    stopCalls++
    return stopBot()
  }
  async getSelfInfo () { return { username: "test bot" } }
}

mock.module("qq-official-bot", {
  exports: { Bot: MockSdk, ReceiverMode: { WEBSOCKET: "websocket" } },
})
mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  exports: {
    getAppid: (...args) => resolveAppid(...args),
    applyUinMapping: async () => {},
    getMappedUin: async () => undefined,
    isQQUin: () => true,
    isGuildUserId: value => String(value).startsWith("qg_"),
    saveMapping: (...args) => saveMapping(...args),
  },
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  exports: { getGroupUin: async () => undefined },
})
mock.module(new URL("../lib/messageBuilder.js", import.meta.url).href, {
  exports: { makeMessage: (...args) => handleMessage(...args) },
})
mock.module(new URL("../lib/messageStore.js", import.meta.url).href, {
  exports: { getRecordByMsgId: async () => undefined },
})
mock.module(new URL("../lib/streamMessage.js", import.meta.url).href, {
  exports: { makeStreamReplyPayload: value => value },
})
mock.module(new URL("../../../lib/config/config.js", import.meta.url).href, {
  exports: { default: { master: { "test-bot": ["owner"] } } },
})

const previousBot = global.Bot
const previousSegment = global.segment
global.Bot = Object.assign(new EventEmitter(), {
  makeLog: (...args) => { logs.push(args) },
  em (...args) { this.emit(...args) },
})
global.segment = { button: buttons => ({ type: "button", buttons }) }

const adapter = {
  id: "QQBot",
  name: "test adapter",
  version: "test",
  config: { bot: {} },
  getFriendMap: async () => new Map(),
  getGroupMap: async () => new Map(),
  getMemberMap: async () => new Map(),
}
const { connectBot } = await import("../lib/client.js")
await test("connects and keeps message audit events outside the message handlers", async () => {
  assert.equal(await connectBot(adapter, "test-bot:test-appid:placeholder:placeholder"), true)
  const sdk = Bot["test-bot"].sdk
  for (const type of ["private", "group", "guild"])
    assert.equal(sdk.listenerCount(`message.${type}`), 1)
  assert.equal(sdk.listenerCount("notice"), 1)
  assert.equal(sdk.listenerCount("message.audit.pass"), 0)
  assert.equal(sdk.listenerCount("message.audit.reject"), 0)
})

await test("logout returns and waits for stop without requiring a close event", async () => {
  let finish
  const stopping = new Promise(resolve => { finish = resolve })
  stopBot = () => stopping
  const result = Bot["test-bot"].logout()
  assert.equal(result, stopping)
  assert.equal(Bot["test-bot"].sdk.receiver.listenerCount("close"), 0)
  let settled = false
  void result.then(() => { settled = true })
  await nextTurn()
  assert.equal(settled, false)
  finish()
  await result
  assert.equal(settled, true)
})

await test("logout propagates stop failure and repeated calls complete without close", async () => {
  const error = new Error("stop failed")
  stopBot = () => Promise.reject(error)
  await assert.rejects(Bot["test-bot"].logout(), value => value === error)
  stopBot = async () => {}
  const before = stopCalls
  await Promise.all([Bot["test-bot"].logout(), Bot["test-bot"].logout()])
  assert.equal(stopCalls, before + 2)
  assert.equal(Bot["test-bot"].sdk.receiver.listenerCount("close"), 0)
})

await test("a rejected SDK startup is reported as a failed connection", async () => {
  const error = new Error("startup failed")
  startBot = () => Promise.reject(error)
  assert.equal(await connectBot(adapter, "failed-bot:test-appid:placeholder:placeholder"), false)
  assert.equal(logs.at(-1)[0], "error")
  assert.equal(logs.at(-1)[1].at(-1), error)
  startBot = async () => {}
})

for (const type of ["private", "group", "guild"]) {
  await test(`${type} messages still reach the message builder`, async () => {
    const event = { id: `message-${type}` }
    handleMessage = (...args) => { messages.push(args) }
    const before = logs.length
    Bot["test-bot"].sdk.emit(`message.${type}`, event)
    await nextTurn()
    assert.deepEqual(messages.at(-1), [adapter, "test-bot", event])
    assert.equal(logs.length, before)
  })

  for (const failure of ["throw", "reject"]) {
    await test(`${type} messages catch ${failure} locally`, async () => {
      const error = new Error(`${type} ${failure}`)
      handleMessage = () => {
        if (failure === "throw") throw error
        return Promise.reject(error)
      }
      const before = logs.length
      assert.doesNotThrow(() => Bot["test-bot"].sdk.emit(`message.${type}`, {}))
      await nextTurn()
      assert.equal(logs.length, before + 1)
      assert.deepEqual(logs.at(-1), [
        "error", ["处理消息事件失败", `message.${type}`, error], "test-bot",
      ])
    })
  }
}

await test("notice failures keep their existing local error handler", async () => {
  const error = new Error("notice mapping failed")
  resolveAppid = () => { throw error }
  const event = { sub_type: "member.increase", group_id: "group", user_id: "user" }
  const before = logs.length
  Bot["test-bot"].sdk.emit("notice", event)
  await nextTurn()
  assert.equal(logs.length, before + 1)
  assert.deepEqual(logs.at(-1), ["error", ["处理通知事件失败", event, error], "test-bot"])
  resolveAppid = bot => bot.info.appid
})

await import("../app/bind.js")
for (const eventName of ["message.private.friend", "message.group.normal"]) {
  const makeEvent = overrides => ({
    bot: Bot["test-bot"],
    self_id: "test-bot",
    user_id: "owner",
    _raw_user_id: "test-openid",
    message_type: eventName.includes("private") ? "private" : "group",
    raw_message: "#QQ绑定",
    message: [],
    ...overrides,
  })

  await test(`${eventName} binding help still replies normally`, async () => {
    const replies = []
    const before = logs.length
    Bot.emit(eventName, makeEvent({ reply: async value => { replies.push(value) } }))
    await nextTurn()
    assert.equal(replies.length, 1)
    assert.equal(replies[0][1].type, "button")
    assert.equal(logs.length, before)
  })

  for (const failure of ["throw", "reject"]) {
    await test(`${eventName} binding catches reply ${failure}`, async () => {
      const error = new Error(`binding reply ${failure}`)
      const before = logs.length
      const event = makeEvent({
        reply () {
          if (failure === "throw") throw error
          return Promise.reject(error)
        },
      })
      assert.doesNotThrow(() => Bot.emit(eventName, event))
      await nextTurn()
      assert.equal(logs.length, before + 1)
      assert.deepEqual(logs.at(-1), ["error", ["QQBot 绑定消息处理失败", error], "test-bot"])
    })
  }

  await test(`${eventName} binding catches a failed error reply without another reply`, async () => {
    const mappingError = new Error("mapping write failed")
    const replyError = new Error("failure reply failed")
    saveMapping = async () => { throw mappingError }
    let replies = 0
    const before = logs.length
    Bot.emit(eventName, makeEvent({
      raw_message: `#QQ强制绑定openid ${"a".repeat(32)} 123456`,
      reply: async () => {
        replies++
        throw replyError
      },
    }))
    await nextTurn()
    assert.equal(replies, 1)
    assert.equal(logs.length, before + 2)
    assert.equal(logs.at(-2)[1].at(-1), mappingError)
    assert.deepEqual(logs.at(-1), ["error", ["QQBot 绑定消息处理失败", replyError], "test-bot"])
    saveMapping = async () => true
  })
}

mock.restoreAll()
global.Bot = previousBot
global.segment = previousSegment
