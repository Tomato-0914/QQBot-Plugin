import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"

// Run with: node --test test/markdownCompat.test.js
// 官方 Markdown 不支持 HTML 折叠块 <details>，发送前展开成普通 Markdown
const { fixMarkdownMessages, unfoldDetails } = await import("../lib/markdownCompat.js")

test("折叠块展开：标题加粗单独一行，内容照常显示", () => {
  assert.equal(unfoldDetails("<details><summary>折叠块</summary></details>"), "**折叠块**")
  assert.equal(
    unfoldDetails("前文\n<details>\n<summary>点我展开</summary>\n\n- 第一条\n- 第二条\n</details>\n后文"),
    "前文\n**点我展开**\n- 第一条\n- 第二条\n后文",
  )
  assert.equal(unfoldDetails("<details open>没有标题的内容</details>"), "没有标题的内容")
  assert.equal(unfoldDetails("文字<DETAILS><Summary>标题</Summary>内容</DETAILS>后面"), "文字\n**标题**\n内容\n后面")
})

test("嵌套折叠块由内向外展开，残留的标签去掉", () => {
  assert.equal(
    unfoldDetails("<details><summary>外层</summary>外内容<details><summary>内层</summary>内内容</details></details>"),
    "**外层**\n外内容\n**内层**\n内内容",
  )
  assert.equal(unfoldDetails("残留 <summary>孤立标题</summary> 和 </details>"), "残留 **孤立标题** 和 ")
})

test("代码块和行内代码里的折叠块不处理，没有折叠块时原样返回", () => {
  const code = "代码里不动：\n```html\n<details><summary>x</summary>y</details>\n```\n以及 `<details>` 行内"
  assert.equal(unfoldDetails(code), code)
  assert.equal(
    unfoldDetails("```\n<details>\n```\n<details><summary>外面的</summary>要展开</details>"),
    "```\n<details>\n```\n**外面的**\n要展开",
  )
  assert.equal(unfoldDetails("普通文字 <qqbot-at-user id=\"x\" />"), "普通文字 <qqbot-at-user id=\"x\" />")
  assert.equal(unfoldDetails(undefined), undefined)
})

test("只处理待发送消息里的 Markdown 文本内容", () => {
  const messages = [
    [{ type: "reply", data: { id: "m1" } }, { type: "markdown", data: { content: "<details><summary>标题</summary>内容</details>" } }],
    [{ type: "text", data: { text: "<details>文字段不动</details>" } }],
    [{ type: "markdown", data: { custom_template_id: "tpl", params: [] } }],
  ]
  fixMarkdownMessages(messages)
  assert.equal(messages[0][1].data.content, "**标题**\n内容")
  assert.equal(messages[1][0].data.text, "<details>文字段不动</details>")
  assert.deepEqual(messages[2][0].data, { custom_template_id: "tpl", params: [] })
})

test("群聊和私聊的发送出口都经过折叠块处理", () => {
  const source = fs.readFileSync(new URL("../lib/messageSender.js", import.meta.url), "utf8")
  assert.match(source, /fixMarkdownMessages\(await adapter\.converter\.makeRawMarkdownMsg\(scopedData, msg\)\)/)
})
