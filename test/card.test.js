import assert from "node:assert/strict"
import { test } from "node:test"

// 图文卡片（msg_type 8）：segment.card({ title, description, pic_url, url })
global.Bot = {
  String: value => String(value),
  makeLog () {},
}
global.redis = { get: async () => null }

const { installCardSegment, makeCardElement } = await import("../lib/card.js")
const { Converter } = await import("../lib/converter.js")
const { MessageBuilder } = await import("../lib/modules/qq-official-bot/lib/message/builder.js")

const card = {
  title: "晴天",
  description: "周杰伦",
  pic_url: "http://y.gtimg.cn/a.jpg",
  url: "https://y.qq.com/n/ryqq/songDetail/abc",
}

await test("card 消息段转成开放平台 card 字段", () => {
  assert.deepEqual(makeCardElement(card), {
    type: "card",
    data: {
      type: "tuwen",
      content: {
        title: "晴天",
        description: "周杰伦",
        pic_url: "http://y.gtimg.cn/a.jpg",
        url: "https://y.qq.com/n/ryqq/songDetail/abc?qq_aio_chat_type=3",
      },
    },
  })
  const long = makeCardElement({ ...card, title: "长".repeat(60), url: "https://a.com/?x=1&qq_aio_chat_type=3" })
  assert.equal(long.data.content.title.length, 50)
  assert.ok(long.data.content.title.endsWith("…"))
  assert.equal(long.data.content.url, "https://a.com/?x=1&qq_aio_chat_type=3", "已有参数不重复追加")
  assert.equal(makeCardElement({ ...card, url: "https://a.com/?x=1" }).data.content.url, "https://a.com/?x=1&qq_aio_chat_type=3")
})

await test("缺字段或链接不合法时报错", () => {
  assert.throws(() => makeCardElement({ ...card, title: "" }), /均为必填/)
  assert.throws(() => makeCardElement({ ...card, url: "http://a.com" }), /https/)
  assert.throws(() => makeCardElement({ ...card, pic_url: "file:///a.jpg" }), /pic_url/)
})

await test("installCardSegment 注册 segment.card，不覆盖已有的", () => {
  const segment = {}
  installCardSegment(segment)
  assert.deepEqual(segment.card(card), { type: "card", ...card })
  const own = () => "own"
  const other = { card: own }
  installCardSegment(other)
  assert.equal(other.card, own)
})

await test("SDK 把 card 元素构建为 msg_type 8", async () => {
  const builder = new MessageBuilder("appid", false)
  const { messagePayload } = await builder.build([makeCardElement(card)])
  assert.equal(messagePayload.msg_type, 8)
  assert.equal(messagePayload.card.type, "tuwen")
  assert.equal(messagePayload.card.content.title, "晴天")
})

await test("转换器把卡片单独作为一条消息，前面的文字照常发送", async () => {
  const converter = new Converter({ sep: ":", config: { markdownImage: false } })
  const data = { self_id: "10000", message_type: "group", bot: { info: { appid: "appid" } } }
  const msg = ["来听歌", { type: "card", ...card }]

  const markdown = await converter.makeRawMarkdownMsg(data, msg)
  assert.equal(markdown.length, 2)
  assert.equal(markdown[0][0].type, "markdown")
  assert.equal(markdown[1][0].type, "card")

  const plain = await converter.makeMsg(data, msg)
  assert.deepEqual(plain.map(m => m.map(i => i.type)), [["text"], ["card"]])

  const rich = await converter.makeRawMarkdownMsg(data, [{ type: "image", file: "https://a.com/a.png" }, "看图", { type: "card", ...card }])
  assert.ok(rich.some(m => m[0]?.type === "card" && m.length === 1))
})
