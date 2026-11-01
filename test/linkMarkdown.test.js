import assert from "node:assert/strict"
import { test } from "node:test"

// Run with: node --test test/linkMarkdown.test.js
// 文字里的网址转成 Markdown 链接 [链接文字](网址)
global.Bot = {
  String: value => String(value),
  makeLog () {},
}
global.redis = { get: async () => null }

const { linkifyText } = await import("../lib/linkMarkdown.js")
const { forwardToMarkdown } = await import("../lib/forwardMarkdown.js")
const { Converter } = await import("../lib/converter.js")

test("默认链接文字为 🔗 加域名，去掉 www.", () => {
  assert.equal(linkifyText("视频：https://www.bilibili.com/video/BV1xx 快看"),
    "视频：[🔗 bilibili.com](https://www.bilibili.com/video/BV1xx) 快看")
  assert.equal(linkifyText("https://b23.tv/abc"), "[🔗 b23.tv](https://b23.tv/abc)")
})

test("链接文字可以自定义，{host} 换成域名", () => {
  assert.equal(linkifyText("看 https://a.com/x", { linkText: "点击跳转" }), "看 [点击跳转](https://a.com/x)")
  assert.equal(linkifyText("看 https://a.com/x", { linkText: "打开 {host}" }), "看 [打开 a.com](https://a.com/x)")
  // 链接文字里的方括号会提前闭合链接，去掉
  assert.equal(linkifyText("看 https://a.com/x", { linkText: "[跳转]" }), "看 [跳转](https://a.com/x)")
})

test("网址在中文标点、空白、末尾英文标点处结束，多余的右括号属于正文", () => {
  assert.equal(linkifyText("地址是https://a.com/x，记得看。"), "地址是[🔗 a.com](https://a.com/x)，记得看。")
  assert.equal(linkifyText("见 https://a.com/x. 完"), "见 [🔗 a.com](https://a.com/x). 完")
  assert.equal(linkifyText("(见 https://a.com/x)"), "(见 [🔗 a.com](https://a.com/x))")
  assert.equal(linkifyText("https://zh.wikipedia.org/wiki/A_(B)"),
    "[🔗 zh.wikipedia.org](https://zh.wikipedia.org/wiki/A_%28B%29)")
  assert.equal(linkifyText("两个 https://a.com 和 https://b.com/?q=1&x=2"),
    "两个 [🔗 a.com](https://a.com) 和 [🔗 b.com](https://b.com/?q=1&x=2)")
})

test("IPv6 地址的网址：方括号属于网址，链接文字去掉方括号", () => {
  assert.equal(linkifyText("面板 http://[fe80::1]:48370/api/x 打开"),
    "面板 [🔗 fe80::1](http://[fe80::1]:48370/api/x) 打开")
  assert.equal(linkifyText("https://[2406:da18::bad8]/"), "[🔗 2406:da18::bad8](https://[2406:da18::bad8]/)")
})

test("已经是 Markdown 链接的不处理；没有网址时原样返回；其余文字交给 escape", () => {
  const md = "[文档](https://a.com/doc) 和 <https://b.com> 和 [https://c.com](https://c.com)"
  assert.equal(linkifyText(md), md)
  assert.equal(linkifyText("没有网址"), "没有网址")
  assert.equal(linkifyText("http://"), "http://")
  assert.equal(linkifyText("ab https://a.com/x cd", { escape: text => text.toUpperCase() }), "AB [🔗 a.com](https://a.com/x) CD")
})

test("发送时文字段的网址转成链接，网址里的 @ 不被转义；linkMarkdown: false 时不转换", async () => {
  const data = { self_id: "10000", message_type: "group", bot: { info: { appid: "appid" } } }
  const converter = new Converter({ sep: ":", config: { linkMarkdownText: "点击跳转" } })
  const [[markdown]] = await converter.makeRawMarkdownMsg(data, "@所有人 看 https://a.com/u@b")
  assert.equal(markdown.data.content, "@​所有人 看 [点击跳转](https://a.com/u@b)")

  const off = new Converter({ sep: ":", config: { linkMarkdown: false } })
  const [[plain]] = await off.makeRawMarkdownMsg(data, "看 https://a.com")
  assert.equal(plain.data.content, "看 https://a.com")

  // 手写的 Markdown 段不处理
  const [[raw]] = await converter.makeRawMarkdownMsg(data, { type: "markdown", data: "原样 https://a.com" })
  assert.equal(raw.data.content, "原样 https://a.com")
})

test("纯文字合并转发转 Markdown 时，文字里的网址也转成链接", () => {
  const forward = { type: "node", data: [{ message: "搜索结果" }, { message: "来源 https://a.com/1" }] }
  assert.equal(forwardToMarkdown(forward, { linkify: linkifyText }).data, "### 搜索结果\n> 来源 [🔗 a.com](https://a.com/1)")
  assert.equal(forwardToMarkdown(forward).data, "### 搜索结果\n> 来源 https://a.com/1")
})
