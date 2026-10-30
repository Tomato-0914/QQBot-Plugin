import assert from "node:assert/strict"
import { test } from "node:test"

// 额外的消息段构造器：气泡按钮、小号按钮、指令文字、跳转链接、ark 模板
global.Bot = {
  String: value => String(value),
  makeLog () {},
}
global.redis = { get: async () => null }

const segments = await import("../lib/segments.js")
const { Converter } = await import("../lib/converter.js")
const { MessageBuilder } = await import("../lib/modules/qq-official-bot/lib/message/builder.js")

const converter = new Converter({ sep: ":", config: { markdownImage: false } })
const data = { self_id: "10000", message_type: "group", bot: { info: { appid: "appid" }, callback: {} } }
const payloadOf = async message => (await new MessageBuilder("appid", false).build(message)).messagePayload

await test("installSegments 注册构造器，不覆盖已有的", () => {
  const own = () => "own"
  const segment = { button: own, link: own }
  segments.installSegments(segment)
  assert.equal(segment.link, own)
  for (const name of ["card", "bubble", "buble", "small", "qqbotcmd", "inlinecmd", "ark", "ark23", "ark24", "ark37"])
    assert.equal(typeof segment[name], "function", name)
})

await test("指令文字、跳转链接生成 Markdown 消息段", () => {
  assert.deepEqual(segments.qqbotcmd("帮助", "#帮助"), {
    type: "markdown",
    data: '<qqbot-cmd-input text="%23%E5%B8%AE%E5%8A%A9" show="%E5%B8%AE%E5%8A%A9" reference="false" />',
  })
  assert.equal(segments.qqbotcmd("签到", "#签到", true).data, '<qqbot-cmd-enter text="%23%E7%AD%BE%E5%88%B0" />')
  assert.equal(segments.inlinecmd("菜单", "#菜单", true).data,
    "[菜单](mqqapi://aio/inlinecmd?command=%23%E8%8F%9C%E5%8D%95&enter=true&reply=false)")
  assert.equal(segments.link("加群", "https://qm.qq.com/q/x").data, "[🔗加群](https://qm.qq.com/q/x)")
})

await test("指令文字原样进入 Markdown，不会被转义", async () => {
  const [[markdown]] = await converter.makeRawMarkdownMsg(data, ["点这里：", segments.qqbotcmd("帮助", "#帮助")])
  assert.equal(markdown.data.content, '点这里：<qqbot-cmd-input text="%23%E5%B8%AE%E5%8A%A9" show="%E5%B8%AE%E5%8A%A9" reference="false" />')
})

await test("ark 模板按 kv 构建，兼容字段名写法", async () => {
  const ark37 = segments.ark37({ prompt: "通知", meta_title: "标题", metaSubtitle: "副标题", metacover: "https://a.com/c.png", METAURL: "https://a.com" })
  assert.deepEqual(ark37, {
    type: "ark",
    template_id: 37,
    kv: [
      { key: "#PROMPT#", value: "通知" },
      { key: "#METATITLE#", value: "标题" },
      { key: "#METASUBTITLE#", value: "副标题" },
      { key: "#METACOVER#", value: "https://a.com/c.png" },
      { key: "#METAURL#", value: "https://a.com" },
    ],
  })
  const ark23 = segments.ark(23, { desc: "列表", prompt: "p", list: ["第一条", ["第二条", "https://a.com/2"], { text: "第三条" }] })
  assert.deepEqual(ark23.kv[2], {
    key: "#LIST#",
    obj: [
      { obj_kv: [{ key: "desc", value: "第一条" }] },
      { obj_kv: [{ key: "desc", value: "第二条" }, { key: "link", value: "https://a.com/2" }] },
      { obj_kv: [{ key: "desc", value: "第三条" }] },
    ],
  })
  assert.throws(() => segments.ark(99), /不支持/)

  const [[ark]] = await converter.makeRawMarkdownMsg(data, [ark37])
  const payload = await payloadOf([ark])
  assert.equal(payload.msg_type, 3)
  assert.equal(payload.ark.template_id, 37)
  assert.equal(payload.ark.kv.length, 5)
})

await test("气泡按钮挂到最后一条 Markdown 消息，最多 3 个", async () => {
  const bubble = segments.bubble(
    { text: "签到", input: "#签到" },
    { text: "帮助", input: "#帮助" },
    [{ text: "菜单", input: "#菜单" }, { text: "多余", input: "#多余" }],
  )
  const messages = await converter.makeRawMarkdownMsg(data, ["你好", bubble])
  assert.equal(messages.length, 1)
  const prompt = messages[0].find(i => i.type === "prompt_keyboard")
  assert.deepEqual(prompt.data.buttons.map(b => b.render_data.label), ["签到", "帮助", "菜单"])

  const payload = await payloadOf(messages[0])
  assert.deepEqual(payload.prompt_keyboard.keyboard.content.rows.map(r => r.buttons.map(b => b.render_data.label)), [["签到"], ["帮助"], ["菜单"]])

  // 只有气泡按钮时补一条 Markdown 消息承载
  const only = await converter.makeRawMarkdownMsg(data, [segments.bubble({ text: "签到", input: "#签到" })])
  assert.equal(only[0][0].type, "markdown")
  assert.equal(only[0][1].type, "prompt_keyboard")
})

await test("small() 让本条消息的按钮使用小号字体", async () => {
  const messages = await converter.makeRawMarkdownMsg(data, ["你好", { type: "button", data: [{ text: "签到", input: "#签到" }] }, segments.small()])
  const payload = await payloadOf(messages[0])
  assert.deepEqual(payload.keyboard.content.style, { font_size: "small" })

  const normal = await converter.makeRawMarkdownMsg(data, ["你好", { type: "button", data: [{ text: "签到", input: "#签到" }] }])
  assert.equal((await payloadOf(normal[0])).keyboard.content.style, undefined)
})

await test("普通消息、频道消息忽略气泡按钮和 small，不会变成文字", async () => {
  const plain = await converter.makeMsg(data, ["你好", segments.bubble({ text: "签到", input: "#签到" }), segments.small()])
  assert.deepEqual(plain.flat().filter(i => i.type !== "reply").map(i => i.type), ["text"])
})
