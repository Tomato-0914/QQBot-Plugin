import assert from "node:assert/strict"
import { segment } from "qq-official-bot"
import { MessageService } from "../lib/modules/qq-official-bot/lib/services/message.js"

const payloads = []
let failNext = false
const request = {
  post: async (_url, payload) => {
    payloads.push(structuredClone(payload))
    if (failNext) {
      failNext = false
      throw new Error("send failed")
    }
    return { data: { id: `sent-${payloads.length}` }, status: 200 }
  },
}
const service = new MessageService(request, "appid")

await service.sendGroupMessage("group", "first", { id: "message-1" })
await service.sendGroupMessage("group", "second", { id: "message-1" })
await service.sendGroupMessage("group", "third", { id: "message-1" })
await service.sendGroupMessage("group", "fourth", { id: "message-1" })
await service.sendGroupMessage("group", "fifth", { id: "message-1" })
assert.deepEqual(payloads.slice(0, 5).map(payload => payload.msg_seq), [1, 2, 3, 4, 5])

await service.sendGroupMessage("group", "active")
assert.equal("msg_seq" in payloads[5], false)

await service.sendGroupMessage("group", [segment.reply("message-2"), "reply by segment"])
assert.equal(payloads[6].msg_seq, 1)

failNext = true
await assert.rejects(service.sendGroupMessage("group", "failed", { id: "message-3" }))
await service.sendGroupMessage("group", "retry", { id: "message-3" })
assert.equal(payloads[7].msg_seq, 1)
assert.equal(payloads[8].msg_seq, 1)

function openApiError (code, message) {
  return Object.assign(new Error(message), { code, err_code: code })
}

function createService (responses) {
  const sentPayloads = []
  const request = {
    post: async (_url, payload) => {
      sentPayloads.push(structuredClone(payload))
      const response = responses.shift()
      if (response instanceof Error) throw response
      return { data: response || { id: `sent-${sentPayloads.length}` }, status: 200 }
    },
  }
  return {
    service: new MessageService(request, "appid"),
    payloads: sentPayloads,
  }
}

for (const method of ["sendGroupMessage", "sendPrivateMessage"]) {
  const duplicated = createService([
    openApiError(40054005, "msg_seq 1 duplicated"),
    openApiError(40054005, "msg_seq 2 duplicated"),
    { id: "sequence-retry-success" },
    { id: "next-reply" },
  ])
  const result = await duplicated.service[method]("target", "duplicated", { id: "duplicate-1" })
  assert.equal(result.id, "sequence-retry-success")
  await duplicated.service[method]("target", "next reply", { id: "duplicate-1" })
  assert.deepEqual(duplicated.payloads.map(payload => payload.msg_seq), [1, 2, 3, 4])
}

for (const quoted of [false, true]) {
  const failures = Array.from({ length: 5 }, (_, index) =>
    Object.assign(openApiError(40054005, `msg_seq ${index + 1} duplicated`), { trace_id: `trace-${index + 1}` }))
  const duplicated = createService([...failures])
  await assert.rejects(duplicated.service.sendGroupMessage("group", [
    segment.reply("duplicate-all", quoted, quoted ? "quoted-index" : undefined),
    "all duplicated",
  ]), error => error === failures[4])
  assert.deepEqual(duplicated.payloads.map(payload => payload.msg_seq), [1, 2, 3, 4, 5])
  for (const payload of duplicated.payloads) {
    assert.equal(payload.msg_id, "duplicate-all")
    if (quoted) assert.deepEqual(payload.message_reference, { message_id: "quoted-index" })
  }
}

// A different error stops sequence retries and preserves its original identity.
{
  const failure = openApiError(40034005, "expired during sequence retry")
  const retry = createService([openApiError(40054005, "occupied"), failure])
  await assert.rejects(retry.service.sendGroupMessage("group", "reply", { id: "retry-error" }), error => error === failure)
  assert.deepEqual(retry.payloads.map(payload => payload.msg_seq), [1, 2])
  await retry.service.sendGroupMessage("group", "caller retry", { id: "retry-error" })
  assert.equal(retry.payloads[2].msg_seq, 2)
}

// A new SDK instance after restart recovers from a sequence used by the previous instance.
{
  const occupied = new Set()
  const requests = []
  const request = {
    post: async (_url, payload) => {
      requests.push(structuredClone(payload))
      const key = `${payload.msg_id}:${payload.msg_seq}`
      if (occupied.has(key)) throw openApiError(40054005, "sequence occupied before restart")
      occupied.add(key)
      return { data: { id: `restart-${requests.length}` } }
    },
  }
  await new MessageService(request, "appid").sendPrivateMessage("user", "开始重启", { id: "restart-message" })
  const result = await new MessageService(request, "appid").sendPrivateMessage("user", "重启成功", { id: "restart-message" })
  assert.equal(result.id, "restart-3")
  assert.deepEqual(requests.map(payload => payload.msg_seq), [1, 1, 2])
  assert.ok(requests.every(payload => payload.msg_id === "restart-message"))
}

// Concurrent replies reserve distinct retry sequences within the same upper bound.
{
  const requests = []
  let release
  const started = new Promise(resolve => { release = resolve })
  const service = new MessageService({
    post: async (_url, payload) => {
      requests.push(structuredClone(payload))
      if (requests.length === 2) release()
      await started
      throw openApiError(40054005, "occupied")
    },
  }, "appid")
  const results = await Promise.allSettled([
    service.sendGroupMessage("group", "first", { id: "concurrent" }),
    service.sendGroupMessage("group", "second", { id: "concurrent" }),
  ])
  assert.deepEqual(requests.map(payload => payload.msg_seq), [1, 2, 3, 4, 5])
  assert.ok(results.every(result => result.status === "rejected" && result.reason.err_code === 40054005))
}

// Sequence recovery reuses the uploaded file instead of uploading it for every attempt.
{
  const requests = []
  const service = new MessageService({
    post: async (url, payload) => {
      requests.push({ url, payload: structuredClone(payload) })
      if (url.endsWith("/files")) return { data: { file_info: "uploaded-once" } }
      if (payload.msg_seq === 1) throw openApiError(40054005, "occupied")
      return { data: { id: "media-retry" } }
    },
  }, "appid")
  const result = await service.sendGroupMessage("group", segment.image("https://example.com/image.png"), { id: "media" })
  assert.equal(result.id, "media-retry")
  assert.equal(requests.filter(request => request.url.endsWith("/files")).length, 1)
  const messages = requests.filter(request => request.url.endsWith("/messages"))
  assert.deepEqual(messages.map(request => request.payload.msg_seq), [1, 2])
  assert.ok(messages.every(request => request.payload.media.file_info === "uploaded-once"))
}

// Replies already at sequence 4 only try 4 and 5, without restarting from 1.
{
  const failures = [openApiError(40054005, "4 occupied"), openApiError(40054005, "5 occupied")]
  const retry = createService([{ id: "1" }, { id: "2" }, { id: "3" }, ...failures])
  for (let index = 0; index < 3; index++)
    await retry.service.sendGroupMessage("group", "previous reply", { id: "already-used" })
  await assert.rejects(retry.service.sendGroupMessage("group", "reply", { id: "already-used" }), error => error === failures[1])
  assert.deepEqual(retry.payloads.map(payload => payload.msg_seq), [1, 2, 3, 4, 5])
}

// Axios transport codes do not hide the OpenAPI business code in the response.
{
  const retry = createService([
    Object.assign(new Error("bad request"), { code: "ERR_BAD_REQUEST", response: { data: { err_code: 40054005 } } }),
    { id: "axios-retry" },
  ])
  assert.equal((await retry.service.sendGroupMessage("group", "reply", { id: "axios-error" })).id, "axios-retry")
  assert.deepEqual(retry.payloads.map(payload => payload.msg_seq), [1, 2])
}

// Active messages and event-only replies never enter msg_seq retries.
for (const message of ["active", [{ type: "reply", data: { event_id: "event" } }, "event reply"]]) {
  const failure = openApiError(40054005, "no msg_id")
  const retry = createService([failure])
  await assert.rejects(retry.service.sendGroupMessage("group", message), error => error === failure)
  assert.equal(retry.payloads.length, 1)
  assert.equal("msg_seq" in retry.payloads[0], false)
}

const expiredError = openApiError(40034005, "reply msg_id expired")
const expiredReply = createService([expiredError])
await assert.rejects(
  expiredReply.service.sendGroupMessage("group", "expired reply", { id: "expired-message" }),
  error => error === expiredError,
)
assert.equal(expiredReply.payloads.length, 1)
assert.equal(expiredReply.payloads[0].msg_id, "expired-message")
assert.equal(expiredReply.payloads[0].msg_seq, 1)

for (const failure of [
  new Error("passive quote failed"),
]) {
  const quotedReply = createService([failure])
  await assert.rejects(quotedReply.service.sendGroupMessage("group", [
    segment.reply("quoted-message", true, "quoted-index"),
    "quoted reply",
  ]), error => error === failure)
  assert.equal(quotedReply.payloads.length, 1)
  assert.equal(quotedReply.payloads[0].msg_id, "quoted-message")
  assert.equal(quotedReply.payloads[0].msg_seq, 1)
  assert.deepEqual(quotedReply.payloads[0].message_reference, { message_id: "quoted-index" })
}

const activeReference = createService([{ id: "sent-active-reference" }])
await activeReference.service.sendGroupMessage("group", [
  { type: "reply", data: { msg_idx: "active-reference-index" } },
  "active reference",
])
assert.equal("msg_id" in activeReference.payloads[0], false)
assert.equal("msg_seq" in activeReference.payloads[0], false)
assert.deepEqual(
  activeReference.payloads[0].message_reference,
  { message_id: "active-reference-index" },
)

console.log("sdk msg_seq tests passed")
