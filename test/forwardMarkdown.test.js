import assert from "node:assert/strict"
import { test } from "node:test"
import { forwardToMarkdown, MAX_LENGTH } from "../lib/forwardMarkdown.js"

// Run with: node --test test/forwardMarkdown.test.js
// 纯文字的合并转发改成一条 Markdown

test("AI 思考过程（标题 + 正文）转成加粗标题和引用块", () => {
  const forward = { type: "node", data: [{ message: "思考过程" }, { message: "先查天气。\n\n再回答用户" }] }
  assert.deepEqual(forwardToMarkdown(forward), {
    type: "markdown",
    data: "**思考过程**\n> 先查天气。\n>\n> 再回答用户",
  })
})

test("多个节点各成一段引用；第一个节点较长或多行时不当作标题", () => {
  const forward = {
    type: "node",
    data: [
      { message: "第一条消息，内容比较长，超过二十个字的时候不会被当成标题" },
      { message: [{ type: "text", text: "第二条" }, " 补充"] },
      { message: "" },
    ],
  }
  assert.equal(
    forwardToMarkdown(forward).data,
    "> 第一条消息，内容比较长，超过二十个字的时候不会被当成标题\n\n> 第二条 补充",
  )
})

test("消息段自带 title 时用它做标题；markdown、嵌套转发的文字也能转换", () => {
  const forward = {
    type: "node",
    title: "群记忆列表",
    data: [
      { message: { type: "markdown", data: "**1.** 喜欢猫" } },
      { message: { type: "node", data: [{ message: "嵌套一" }, { message: "嵌套二" }] } },
    ],
  }
  assert.equal(forwardToMarkdown(forward).data, "**群记忆列表**\n> **1.** 喜欢猫\n\n> 嵌套一\n> 嵌套二")
})

test("带图片等非文字内容、或文字过长时保持合并转发不变", () => {
  const withImage = { type: "node", data: [{ message: "封面" }, { message: { type: "image", file: "a.jpg" } }] }
  assert.equal(forwardToMarkdown(withImage), withImage)
  const tooLong = { type: "node", data: [{ message: "长文" }, { message: "字".repeat(MAX_LENGTH + 1) }] }
  assert.equal(forwardToMarkdown(tooLong), tooLong)
  const empty = { type: "node", data: [{ message: "" }] }
  assert.equal(forwardToMarkdown(empty), empty)
})

test("消息数组里只替换可以转换的合并转发，其余消息段不变；没有可转换内容时原样返回", () => {
  const image = { type: "image", file: "b.png" }
  const msg = [{ type: "reply", id: "m1" }, { type: "node", data: [{ message: "列表" }, { message: "一" }] }, image]
  assert.deepEqual(forwardToMarkdown(msg), [{ type: "reply", id: "m1" }, { type: "markdown", data: "**列表**\n> 一" }, image])
  const plain = ["文字", image]
  assert.equal(forwardToMarkdown(plain), plain)
  assert.equal(forwardToMarkdown("文字"), "文字")
})
