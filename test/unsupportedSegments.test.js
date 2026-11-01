import assert from "node:assert/strict"
import { test } from "node:test"
import { fixUnsupportedSegments } from "../lib/unsupportedSegments.js"

// Run with: node --test test/unsupportedSegments.test.js
// 官方机器人发不了的消息段：卡片改成 Markdown 链接，客户端专有的消息段去掉，不再当成 JSON 文字发出去

const miniApp = {
  app: "com.tencent.miniapp_01",
  prompt: "[QQ小程序]哔哩哔哩",
  meta: {
    detail_1: {
      title: "哔哩哔哩",
      desc: "【4K】晴天 (live)",
      qqdocurl: "https://b23.tv/abc",
    },
  },
}

test("json 小程序卡片：取标题和跳转地址，OneBot / icqq 写法、对象 / 字符串都能识别", () => {
  const expected = { type: "markdown", data: "🔗 [哔哩哔哩](https://b23.tv/abc)" }
  assert.deepEqual(fixUnsupportedSegments({ type: "json", data: miniApp }), expected)
  assert.deepEqual(fixUnsupportedSegments({ type: "json", data: JSON.stringify(miniApp) }), expected)
  assert.deepEqual(fixUnsupportedSegments({ type: "json", data: { data: JSON.stringify(miniApp) } }), expected)
})

test("链接分享卡片取 news 的 jumpUrl；没有地址时发 [卡片] 标题；解析不了时去掉", () => {
  const news = { app: "com.tencent.structmsg", prompt: "[分享]标题", meta: { news: { title: "新闻[标题]", jumpUrl: "https://example.com/a b" } } }
  assert.deepEqual(fixUnsupportedSegments({ type: "json", data: news }),
    { type: "markdown", data: "🔗 [新闻 标题](https://example.com/a%20b)" })
  assert.deepEqual(fixUnsupportedSegments({ type: "json", data: { app: "x", prompt: "[群公告]明天放假" } }),
    { type: "text", text: "[卡片] [群公告]明天放假" })
  assert.deepEqual(fixUnsupportedSegments(["前", { type: "json", data: "不是 JSON" }, "后"]), ["前", "后"])
})

test("xml 卡片：取 url 属性和 title", () => {
  const xml = '<?xml version="1.0"?><msg serviceID="1" brief="[链接]简介" url="https://example.com/?a=1&amp;b=2"><item><title>标题 &amp; 副标题</title></item></msg>'
  assert.deepEqual(fixUnsupportedSegments({ type: "xml", data: xml }),
    { type: "markdown", data: "🔗 [标题 & 副标题](https://example.com/?a=1&b=2)" })
  assert.deepEqual(fixUnsupportedSegments({ type: "xml", data: { data: '<msg brief="只有简介"/>' } }),
    { type: "text", text: "[卡片] 只有简介" })
})

test("链接分享、位置转换；戳一戳、骰子等去掉；其他消息段不变", () => {
  const msg = [
    "你好",
    { type: "share", data: { url: "https://example.com", title: "示例" } },
    { type: "location", data: { name: "天安门", address: "北京市东城区" } },
    { type: "poke", qq: 10001 },
    { type: "dice" },
    { type: "image", file: "a.jpg" },
  ]
  assert.deepEqual(fixUnsupportedSegments(msg), [
    "你好",
    { type: "markdown", data: "🔗 [示例](https://example.com)" },
    { type: "text", text: "[位置] 天安门 北京市东城区" },
    { type: "image", file: "a.jpg" },
  ])
  assert.deepEqual(fixUnsupportedSegments({ type: "poke", qq: 1 }), [])
})

test("合并转发节点里的卡片也会转换；没有要处理的内容时原样返回", () => {
  const forward = { type: "node", data: [{ nickname: "a", message: [{ type: "json", data: miniApp }, "说明"] }] }
  const fixed = fixUnsupportedSegments([forward])
  assert.deepEqual(fixed[0].data[0].message, [{ type: "markdown", data: "🔗 [哔哩哔哩](https://b23.tv/abc)" }, "说明"])

  const plain = ["文字", { type: "image", file: "a.jpg" }]
  assert.equal(fixUnsupportedSegments(plain), plain)
  assert.equal(fixUnsupportedSegments("文字"), "文字")
})
