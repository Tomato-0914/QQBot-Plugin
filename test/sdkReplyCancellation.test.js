import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { MessageService } from "../lib/modules/qq-official-bot/lib/services/message.js"
import { ChunkedUploader } from "../lib/modules/qq-official-bot/lib/message/chunked-upload.js"

function error (code) {
  return Object.assign(new Error(`API code ${code}`), { code, err_code: code })
}

// Ordinary sends only retry sequence conflicts; no SDK send falls back to active.
for (const method of ["sendGroupMessage", "sendPrivateMessage", "sendGuildMessage", "sendDirectMessage"]) {
  for (const quoted of [false, true]) {
    for (const options of [undefined, { timeout: 0 }]) {
      for (const failure of [
        error(40034005),
        error(40054005),
        error(304010),
        Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      ]) {
        const calls = []
        const service = new MessageService({
          post: async (url, body, options) => {
            calls.push({ url, body: structuredClone(body), options })
            throw failure
          },
        }, "appid")
        await assert.rejects(service[method]("target", [
          { type: "reply", data: { id: "original", ...(quoted ? { msg_idx: "reference" } : {}) } },
          "message",
        ], undefined, options), exception => exception === failure)
        assert.equal(calls.length, failure.err_code === 40054005 ? 5 : 1)
        assert.deepEqual(calls.map(call => call.body.msg_seq), failure.err_code === 40054005 ? [1, 2, 3, 4, 5] : [1])
        assert.ok(calls.every(call => call.body.msg_id === "original"))
        assert.equal(calls[0].options.timeout, options?.timeout ?? 10000)
        assert.equal(calls[0].body.msg_id, "original")
        assert.equal(calls[0].body.msg_seq, 1)
        if (quoted) assert.deepEqual(calls[0].body.message_reference, { message_id: "reference" })
      }
    }
  }
}

// Default SDK callers keep the original timeout unless they explicitly disable it.
{
  const timeouts = []
  const service = new MessageService({
    post: async (url, body, options) => {
      timeouts.push(options.timeout)
      return { data: { id: "sent" } }
    },
  }, "appid")
  await service.sendGroupMessage("group", "default")
  await service.sendPrivateMessage("user", "no-timeout", undefined, { timeout: 0 })
  assert.deepEqual(timeouts, [10000, 0])
}

// Cancellation never triggers a quoted active fallback or another HTTP request.
{
  const controller = new AbortController()
  let calls = 0
  const service = new MessageService({
    post: async (url, body, options) => {
      calls++
      assert.equal(options.signal, controller.signal)
      controller.abort()
      throw error(40054005)
    },
  }, "appid")
  await assert.rejects(service.sendGroupMessage("group", [
    { type: "reply", data: { id: "original", msg_idx: "reference" } },
    "message",
  ], undefined, { timeout: 0, signal: controller.signal }))
  assert.equal(calls, 1)
}

const uploadFile = fileURLToPath(new URL("./fixtures/replyUpload.txt", import.meta.url))

// A canceled upload stops before hashing, HTTP requests or any retries.
{
  const controller = new AbortController()
  controller.abort()
  const uploader = new ChunkedUploader({
    post: async () => { throw new Error("Canceled upload must not issue a request") },
  })
  await assert.rejects(uploader.upload("/v2/groups/group", uploadFile, 4, {
    signal: controller.signal,
  }), exception => exception.name === "AbortError")
}

// Cancellation reaches upload_prepare and prevents completing or retrying the upload.
{
  const controller = new AbortController()
  let calls = 0
  const uploader = new ChunkedUploader({
    post: async (url, body, options) => {
      calls++
      assert.ok(url.endsWith("/upload_prepare"))
      assert.equal(options.signal, controller.signal)
      controller.abort()
      throw new Error("upload canceled")
    },
  })
  await assert.rejects(uploader.upload("/v2/groups/group", uploadFile, 4, {
    signal: controller.signal,
  }))
  assert.equal(calls, 1)
}

// Cancellation during COS transfer does not finish a part or retry the transfer.
{
  const controller = new AbortController()
  const originalFetch = global.fetch
  let transfers = 0
  let apiCalls = 0
  global.fetch = async (url, options) => {
    transfers++
    controller.abort()
    assert.equal(options.signal.aborted, true)
    throw new Error("COS upload canceled")
  }
  try {
    const uploader = new ChunkedUploader({
      post: async url => {
        apiCalls++
        assert.ok(url.endsWith("/upload_prepare"))
        return {
          data: {
            upload_id: "upload",
            block_size: 1000,
            parts: [{ index: 1, presigned_url: "https://example.invalid/upload" }],
          },
        }
      },
    })
    await assert.rejects(uploader.upload("/v2/groups/group", uploadFile, 4, {
      signal: controller.signal,
    }), exception => exception.name === "AbortError")
    assert.equal(transfers, 1)
    assert.equal(apiCalls, 1)
  } finally {
    global.fetch = originalFetch
  }
}

console.log("SDK reply cancellation tests passed")
