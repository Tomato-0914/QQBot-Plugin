import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mock } from "node:test"

global.Bot = {
  String: value => String(value),
  makeLog () {},
}

const { MessageService } = await import("../lib/modules/qq-official-bot/lib/services/message.js")
const { installMessageSender } = await import("../lib/messageSender.js")
const { setMessageStoreRoot } = await import("../lib/messageStore.js")
const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-reply-deadline-"))
setMessageStoreRoot(storeRoot)
mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1791720000000 })

let messageIndex = 0
const markdownImage = [{ type: "markdown", data: { content: "![image](https://example.com/a.jpg)" } }]
const flush = () => new Promise(resolve => setImmediate(resolve))

function createTransport (script) {
  const calls = []
  const request = {
    post: async (url, body, options) => {
      calls.push({ url, body: structuredClone(body), ...options })
      assert.ok(script.length, "Unexpected extra send attempt")
      const step = script.shift()
      if (step instanceof Error) throw step
      if (typeof step === "function") return step(options)
      return { data: step || { id: `sent-${calls.length}` }, status: 200 }
    },
  }
  return { calls, service: new MessageService(request, "appid") }
}

function openApiError (code) {
  return Object.assign(new Error(`Request failed with code(${code})`), { code, err_code: code })
}

function waitForAbort ({ signal }) {
  assert.ok(signal)
  return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("canceled"), { code: "ERR_CANCELED" }))
    if (signal.aborted) fail()
    else signal.addEventListener("abort", fail, { once: true })
  })
}

function createAdapter (quoted = false) {
  const adapter = {
    sep: ":",
    config: { forceVerifyImageResource: true, messageTimeout: 30000, bot: { timeout: 30000 } },
    converter: {
      makeRawMarkdownMsg: async (data, message) => [[
        { type: "reply", data: { id: data.message_id, ...(quoted ? { msg_idx: "REFIDX_ORIGINAL" } : {}) } },
        ...message,
      ]],
      refreshMarkdownImages: async () => { throw new Error("Failed sends must not refresh or retry") },
    },
  }
  installMessageSender(adapter)
  return adapter
}

function createData (service) {
  return {
    self_id: "bot",
    message_type: "group",
    group_id: "group-openid",
    user_id: "user-openid",
    message_id: `ROBOT1.0_ORIGINAL_${++messageIndex}`,
    raw: { timestamp: Date.now() / 1000 },
    _reply_received_at: Date.now(),
    bot: {
      info: { id: "bot-openid" },
      nickname: "bot",
      sdk: {
        sendGroupMessage: (...args) => service.sendGroupMessage(...args),
        sendPrivateMessage: (...args) => service.sendPrivateMessage(...args),
      },
    },
  }
}

try {
  // Existing 30-second settings cannot impose an HTTP timeout.
  {
    let complete
    const { calls, service } = createTransport([
      () => new Promise(resolve => { complete = resolve }),
    ])
    const adapter = createAdapter()
    const data = createData(service)
    let settled = false
    const sending = adapter.sendGroupMsg(data, markdownImage).finally(() => { settled = true })
    await flush()
    assert.equal(calls[0].timeout, 0)
    mock.timers.tick(31000)
    await flush()
    assert.equal(settled, false)
    assert.equal(calls[0].signal.aborted, false)
    assert.equal(calls.length, 1)
    complete({ data: { id: "slow-success" }, status: 200 })
    assert.deepEqual((await sending).message_id, ["slow-success"])
    assert.equal(calls.length, 1)
  }

  // Early network, API, expired-ID and quoted failures are discarded immediately.
  for (const quoted of [false, true]) {
    for (const error of [
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      openApiError(304010),
      openApiError(40034005),
      openApiError(40054005),
      openApiError(50055001),
    ]) {
      const { calls, service } = createTransport([error])
      const result = await createAdapter(quoted).sendGroupMsg(createData(service), markdownImage)
      assert.equal(calls.length, 1)
      assert.deepEqual(result.message_id, [])
      assert.equal(result.error[0], error)
    }
  }

  // A waiting passive request is canceled exactly at the original five-minute deadline.
  for (const quoted of [false, true]) {
    const { calls, service } = createTransport([waitForAbort, { id: "active-success" }])
    const adapter = createAdapter(quoted)
    const data = createData(service)
    const sending = adapter.sendGroupMsg(data, markdownImage)
    await flush()
    mock.timers.tick(299999)
    await flush()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].signal.aborted, false)
    mock.timers.tick(1)
    await flush()
    const result = await sending
    assert.equal(calls.length, 2)
    assert.equal(calls[0].signal.aborted, true)
    assert.equal(calls[0].body.msg_id, data.message_id)
    assert.equal("msg_id" in calls[1].body, false)
    assert.equal("msg_seq" in calls[1].body, false)
    assert.equal(calls[1].timeout, 0)
    assert.equal(calls[1].signal, undefined)
    if (quoted) assert.deepEqual(calls[1].body.message_reference, { message_id: "REFIDX_ORIGINAL" })
    assert.deepEqual(result.message_id, ["active-success"])
    assert.deepEqual(result.error, [])
  }

  // Active failure after the deadline is returned once, without another send.
  {
    const error = openApiError(40034105)
    const { calls, service } = createTransport([waitForAbort, error])
    const sending = createAdapter().sendGroupMsg(createData(service), markdownImage)
    await flush()
    mock.timers.tick(300000)
    await flush()
    const result = await sending
    assert.equal(calls.length, 2)
    assert.deepEqual(result.message_id, [])
    assert.equal(result.error[0], error)
  }

  // The deadline uses original timestamps, not the time the reply starts.
  for (const format of [
    time => time / 1000,
    time => time,
    time => new Date(time).toISOString(),
  ]) {
    const { calls, service } = createTransport([waitForAbort, { id: "delayed-active" }])
    const data = createData(service)
    data.raw.timestamp = format(Date.now() - 290000)
    const sending = createAdapter().sendGroupMsg(data, markdownImage)
    await flush()
    mock.timers.tick(9999)
    await flush()
    assert.equal(calls.length, 1)
    mock.timers.tick(1)
    await flush()
    await sending
    assert.equal(calls.length, 2)
  }

  // Already expired messages start with one active attempt; failures are discarded.
  {
    const error = openApiError(40034105)
    const { calls, service } = createTransport([error])
    const data = createData(service)
    data.raw.timestamp -= 301
    const result = await createAdapter().sendGroupMsg(data, markdownImage)
    assert.equal(calls.length, 1)
    assert.equal("msg_id" in calls[0].body, false)
    assert.equal(result.error[0], error)
  }

  // The existing five-reply limit is retained.
  {
    const { calls, service } = createTransport(Array.from({ length: 6 }, (_, index) => ({ id: `limit-${index}` })))
    const data = createData(service)
    const adapter = createAdapter()
    for (let index = 0; index < 6; index++) await adapter.sendGroupMsg(data, markdownImage)
    assert.deepEqual(calls.slice(0, 5).map(call => call.body.msg_seq), [1, 2, 3, 4, 5])
    assert.equal("msg_id" in calls[5].body, false)
  }

  // Friends use the same cancellation policy and no per-request timeout.
  {
    const { calls, service } = createTransport([waitForAbort, { id: "friend-active" }])
    const data = createData(service)
    data.message_type = "private"
    const sending = createAdapter().sendFriendMsg(data, markdownImage)
    await flush()
    mock.timers.tick(300000)
    await flush()
    assert.deepEqual((await sending).message_id, ["friend-active"])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, "/v2/users/user-openid/messages")
    assert.equal(calls[0].timeout, 0)
    assert.equal("msg_id" in calls[1].body, false)
  }
  console.log("reply deadline tests passed")
} finally {
  mock.timers.reset()
  assert.ok(storeRoot.startsWith(path.join(os.tmpdir(), "qqbot-reply-deadline-")))
  await fs.rm(storeRoot, { recursive: true, force: true })
}
