import assert from "node:assert/strict"

// 群聊原生图文消息里的 @成员：QQ 只在 Markdown 消息中渲染 <qqbot-at-user>，此前会原样显示成标签文本
global.Bot = {
  String: value => String(value),
  makeLog () {},
}
global.redis = {
  get: async key => key === "map:qqbot:appid:MAPPED-OPENID" ? "123456789" : null,
}

const { Converter } = await import("../lib/converter.js")

const converter = new Converter({ sep: ":", config: { markdownImage: false } })
const data = {
  self_id: "10000",
  message_type: "group",
  bot: {
    info: { appid: "appid" },
    fl: new Map([["UNBOUND-OPENID", { nickname: "小明" }]]),
  },
}
const image = { type: "image", file: "https://example.com/a.png" }

const messages = await converter.makeRawMarkdownMsg(data, [
  image,
  { type: "at", qq: "987654321" },
  { type: "at", qq: "MAPPED-OPENID" },
  { type: "at", qq: "UNBOUND-OPENID" },
  { type: "at", qq: "NAMELESS-OPENID" },
  { type: "at", qq: "all" },
  { type: "text", text: " 看图" },
])

const segments = messages.flat()
assert.ok(segments.some(i => i.type === "image"), "图片仍按原生图文发送")
const texts = segments.filter(i => i.type === "text").map(i => i.data.text)
assert.deepEqual(texts, ["@987654321", "@123456789", "@小明", " 看图"])
// 只有 @全体成员 保留为真实提及，其余 @成员 不再生成 <qqbot-at-user> 标签
assert.deepEqual(segments.filter(i => i.type === "at").map(i => i.data.user_id), ["all"])

console.log("native at tests passed")
process.exit(0)
