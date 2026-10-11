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

const duplicateError = openApiError(40054005, "msg_seq 1 duplicated")
const duplicated = createService([duplicateError, { id: "caller-retry" }])
await assert.rejects(
  duplicated.service.sendGroupMessage("group", "duplicated", { id: "duplicate-1" }),
  error => error === duplicateError,
)
assert.deepEqual(duplicated.payloads.map(payload => payload.msg_seq), [1])
await duplicated.service.sendGroupMessage("group", "caller retry", { id: "duplicate-1" })
assert.deepEqual(duplicated.payloads.map(payload => payload.msg_seq), [1, 1])

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
  openApiError(40054005, "quoted msg_seq duplicated"),
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
