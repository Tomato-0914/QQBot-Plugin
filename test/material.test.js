import assert from "node:assert/strict"
import { mock, test } from "node:test"
import sharp from "sharp"

// Run with: node --experimental-test-module-mocks --test test/material.test.js
// Mock host configuration and QQ transport; never load accounts or write chat records.
mock.module(new URL("../../../lib/config/config.js", import.meta.url).href, {
  exports: { default: {} },
})

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64")
const logs = []
global.Bot = {
  String: value => String(value),
  Buffer: async (file, options = {}) => {
    if (Buffer.isBuffer(file)) return file
    // Host Bot.Buffer returns a URL unchanged when http: true is set.
    assert.notEqual(options.http, true, "material upload must read URL bytes")
    if (file === "https://example.test/chart.png" || file === "./chart.png") return png
    throw new Error("unreadable image")
  },
  makeLog: (...args) => logs.push(args),
  fileToUrl: () => { throw new Error("must not use the old image host") },
  uin: ["other-bot"],
  "other-bot": { uploadImage: () => { throw new Error("must not upload through another bot") } },
}

const { Converter } = await import("../lib/converter.js")
const { installMessageSender } = await import("../lib/messageSender.js")
const { MessageService } = await import("../lib/modules/qq-official-bot/lib/services/message.js")
const { MaterialService } = await import("../lib/modules/qq-official-bot/lib/services/material.js")

function image (file = png) {
  return { type: "image", file }
}

function openApiError (code) {
  return Object.assign(new Error(`code(${code})`), { code, err_code: code })
}

function createHarness ({ config, onUpload, onDelete, onSend } = {}) {
  const calls = []
  const active = new Set()
  const materialService = {
    async uploadImage (bytes, options) {
      assert.equal(this, materialService)
      calls.push({ type: "upload", bytes, options })
      if (onUpload) await onUpload(bytes, options)
      const image_id = `image-${calls.filter(call => call.type === "upload").length}`
      active.add(image_id)
      return { image_id, url: `qqbot-media://image/v1/${image_id}` }
    },
    async deleteImage (imageId) {
      calls.push({ type: "delete", imageId })
      if (onDelete) await onDelete(imageId)
      active.delete(imageId)
    },
  }
  const messageService = new MessageService({
    post: async (url, body, options) => {
      calls.push({ type: "send", url, body: structuredClone(body), options })
      for (const match of (body.markdown?.content || "").matchAll(/qqbot-media:\/\/image\/v1\/(image-\d+)/g))
        assert.ok(active.has(match[1]), "素材在发送完成前不能被删除")
      if (onSend) await onSend(body, options)
      return { data: { id: `sent-${calls.length}` }, status: 200 }
    },
  }, "test-appid")
  const adapter = { sep: ":", config: { markdownImage: true, imageLength: 10, toBotUpload: true, ...config } }
  adapter.converter = new Converter(adapter)
  installMessageSender(adapter)
  const data = { self_id: "test-bot", message_type: "group", bot: { sdk: { materialService } } }
  const send = (message, options) => messageService.sendGroupMessage("test-group", message, undefined, options)
  return { adapter, data, calls, active, materialService, send }
}

await test("uploads through the current bot and deletes after the official message request", async () => {
  const h = createHarness()
  const result = await h.adapter.sendMsg(h.data, h.send, ["图表", image()])
  assert.equal(result.error.length, 0)
  assert.deepEqual(h.calls.map(call => call.type), ["upload", "send", "delete"])
  assert.deepEqual(h.calls[0].options, { fileName: "image.png", contentType: "image/png" })
  assert.equal(h.calls[0].bytes, png, "small images must preserve their bytes")
  assert.equal(h.calls[1].body.msg_type, 2)
  assert.equal(h.calls[1].body.markdown.content, "图表![图片 #1px #1px](qqbot-media://image/v1/image-1)")
  assert.equal(h.active.size, 0)
  assert.equal("_materialScope" in h.data, false)
})

await test("reads both URL and local-path image inputs before uploading", async () => {
  for (const source of ["https://example.test/chart.png", "./chart.png"]) {
    const h = createHarness()
    await h.adapter.sendMsg(h.data, h.send, image(source))
    assert.equal(h.calls[0].bytes, png)
    assert.equal(h.active.size, 0)
  }
})

await test("uses the actual JPEG, GIF and WebP formats for upload metadata", async () => {
  for (const [format, contentType, fileName] of [
    ["jpeg", "image/jpeg", "image.jpg"],
    ["gif", "image/gif", "image.gif"],
    ["webp", "image/webp", "image.webp"],
  ]) {
    const bytes = await sharp(png).toFormat(format).toBuffer()
    const h = createHarness()
    await h.adapter.sendMsg(h.data, h.send, image(bytes))
    assert.deepEqual(h.calls[0].options, { contentType, fileName })
    assert.deepEqual(h.calls[0].bytes, bytes)
  }
})

await test("compresses images above 10 MiB and detects the resulting JPEG encoding", async () => {
  const bytes = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)])
  const h = createHarness()
  await h.adapter.sendMsg(h.data, h.send, image(bytes))
  assert.ok(h.calls[0].bytes.length < 10 * 1024 * 1024)
  assert.deepEqual(h.calls[0].options, { fileName: "image.jpg", contentType: "image/jpeg" })
})

await test("keeps material alive until passive-to-active fallback finishes", async () => {
  let attempts = 0
  const h = createHarness({ onSend: () => { if (++attempts === 1) throw openApiError(40034005) } })
  h.data.message_id = "original-message"
  const result = await h.adapter.sendMsg(h.data, h.send, image())
  assert.equal(result.error.length, 0)
  assert.deepEqual(h.calls.map(call => call.type), ["upload", "send", "send", "delete"])
  assert.equal(h.calls[1].body.msg_id, "original-message")
  assert.equal(h.calls[2].body.msg_id, undefined)
  assert.equal(h.calls[1].body.markdown.content, h.calls[2].body.markdown.content)
})

await test("cleans up when both passive and active sends fail", async () => {
  const h = createHarness({ onSend: () => { throw openApiError(40034005) } })
  h.data.message_id = "failed-message"
  const result = await h.adapter.sendMsg(h.data, h.send, image())
  assert.equal(result.error.length, 1)
  assert.deepEqual(h.calls.map(call => call.type), ["upload", "send", "send", "delete"])
  assert.equal(h.active.size, 0)
})

await test("cleans up a previously uploaded image when a later upload fails", async () => {
  let uploads = 0
  const h = createHarness({ onUpload: () => { if (++uploads === 2) throw new Error("upload failed") } })
  await assert.rejects(h.adapter.sendMsg(h.data, h.send, [image(), image()]), /upload failed/)
  assert.deepEqual(h.calls.map(call => call.type), ["upload", "upload", "delete"])
  assert.equal(h.active.size, 0)
})

await test("cleans up if a later image cannot be decoded", async () => {
  const h = createHarness()
  await assert.rejects(h.adapter.sendMsg(h.data, h.send, [image(), image(Buffer.from("invalid image"))]))
  assert.deepEqual(h.calls.map(call => call.type), ["upload", "delete"])
  assert.equal(h.active.size, 0)
})

await test("cleans up after file preparation or persistence failures", async () => {
  const h = createHarness()
  const result = await h.adapter.sendMsg(h.data, h.send, [image(), { type: "file" }], () => { throw new Error("persistence failed") })
  assert.equal(result.message_id.length, 1)
  assert.equal(result.error.length, 1, "invalid file segment must fail during preparation")
  assert.equal(h.active.size, 0)
  assert.deepEqual(h.calls.map(call => call.type), ["upload", "send", "delete"])
})

await test("retains all nested-message materials until the last message completes", async () => {
  const h = createHarness()
  await h.adapter.sendMsg(h.data, h.send, [image(), { type: "node", data: [{ message: image() }] }])
  assert.deepEqual(h.calls.map(call => call.type), ["upload", "upload", "send", "send", "delete", "delete"])
  assert.equal(h.active.size, 0)
})

await test("delete failure does not change successful sending or prevent remaining cleanup", async () => {
  const before = logs.length
  const h = createHarness({ onDelete: id => { if (id === "image-1") throw new Error("delete failed") } })
  const result = await h.adapter.sendMsg(h.data, h.send, [image(), image()])
  assert.equal(result.error.length, 0)
  assert.equal(result.message_id.length, 1)
  assert.deepEqual(h.calls.filter(call => call.type === "delete").map(call => call.imageId), ["image-1", "image-2"])
  assert.ok(logs.slice(before).some(([level, message]) => level === "error" && message[0] === "删除临时图片素材失败"))
})

await test("concurrent sends using the same data clean up only their own images", async () => {
  const releases = []
  const h = createHarness({ onSend: () => new Promise(resolve => releases.push(resolve)) })
  const first = h.adapter.sendMsg(h.data, h.send, image())
  const second = h.adapter.sendMsg(h.data, h.send, image())
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.active.size, 2)
  releases[0]()
  await first
  assert.equal(h.active.size, 1)
  releases[1]()
  await second
  assert.equal(h.active.size, 0)
})

await test("preserves manually supplied material and public-image Markdown links", async () => {
  const h = createHarness()
  const content = "![素材](qqbot-media://image/v1/manual)![公网](https://example.test/image.png)"
  await h.adapter.sendMsg(h.data, h.send, { type: "markdown", data: content })
  assert.deepEqual(h.calls.map(call => call.type), ["send"])
  assert.equal(h.calls[0].body.markdown.content, content)
})

await test("native images do not require a material service", async () => {
  const h = createHarness({ config: { markdownImage: false } })
  delete h.data.bot.sdk.materialService
  const sent = []
  await h.adapter.sendMsg(h.data, async message => { sent.push(message); return { id: "native" } }, image())
  assert.equal(sent[0][0].type, "image")
  assert.equal(h.calls.length, 0)
})

await test("reports a missing material service without falling back to an image host", async () => {
  const h = createHarness()
  delete h.data.bot.sdk.materialService
  await assert.rejects(h.adapter.sendMsg(h.data, h.send, image()), /不支持图片素材管理/)
  assert.equal(h.calls.length, 0)
})

await test("reclaims an uploaded image even if the response URL is invalid", async () => {
  const h = createHarness()
  h.materialService.uploadImage = async () => ({ image_id: "bad-response", url: "https://example.test/invalid" })
  await assert.rejects(h.adapter.sendMsg(h.data, h.send, image()), /上传响应/)
  assert.deepEqual(h.calls, [{ type: "delete", imageId: "bad-response" }])
})

await test("the synced SDK exports material management and rejects oversized images before HTTP", async () => {
  const { MaterialService: ExportedService } = await import("qq-official-bot")
  assert.equal(ExportedService, MaterialService)
  const service = new MaterialService({ post: () => { throw new Error("must not reach HTTP") } })
  await assert.rejects(service.uploadImage(Buffer.alloc(10 * 1024 * 1024 + 1), {
    fileName: "image.png", contentType: "image/png",
  }), /10 MiB/)
})
