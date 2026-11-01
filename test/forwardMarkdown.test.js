import assert from "node:assert/strict"
import { test } from "node:test"
import { forwardToMarkdown, MAX_LENGTH } from "../lib/forwardMarkdown.js"

// Run with: node --test test/forwardMarkdown.test.js
// 纯文字的合并转发改成一条 Markdown

test("AI 思考过程（标题 + 正文）转成小标题和引用块", () => {
  const forward = { type: "node", data: [{ message: "思考过程" }, { message: "先查天气。\n\n再回答用户" }] }
  assert.deepEqual(forwardToMarkdown(forward), {
    type: "markdown",
    data: "### 思考过程\n> 先查天气。\n>\n> 再回答用户",
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
  assert.equal(forwardToMarkdown(forward).data, "### 群记忆列表\n> **1.** 喜欢猫\n\n> 嵌套一\n> 嵌套二")
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
  assert.deepEqual(forwardToMarkdown(msg), [{ type: "reply", id: "m1" }, { type: "markdown", data: "### 列表\n> 一" }, image])
  const plain = ["文字", image]
  assert.equal(forwardToMarkdown(plain), plain)
  assert.equal(forwardToMarkdown("文字"), "文字")
})

test("有结构的消息：分段标题加粗，分段下的键值行变成列表，单独的键值行不做列表，提示放进引用块", () => {
  const forward = {
    type: "node",
    data: [
      { message: "管理面板登录入口已生成。\n请从下面几类地址里选择一项。" },
      { message: "自定义地址：\n没有配置自定义访问地址。" },
      { message: "内网地址：\n网卡 eth0：10.1.0.7\n网卡 eth1: 10.1.0.8" },
      { message: "临时 token：abc-123\n一次性链接 300 秒内有效。\n如果自动登录失败，请手动粘贴 token。" },
    ],
  }
  assert.equal(forwardToMarkdown(forward).data, [
    "### 管理面板登录入口已生成",
    "> 请从下面几类地址里选择一项。",
    "",
    "**自定义地址**",
    "没有配置自定义访问地址。",
    "",
    "**内网地址**",
    "- **网卡 eth0**：10.1.0.7",
    "- **网卡 eth1**：10.1.0.8",
    "",
    "**临时 token**：abc-123",
    "一次性链接 300 秒内有效。",
    "> 如果自动登录失败，请手动粘贴 token。",
  ].join("\n"))
})

test("时间、网址里的冒号和已有的 Markdown 不当成键值；没有结构的消息仍按引用块显示", () => {
  const forward = {
    type: "node",
    data: [
      { message: "提醒" },
      { message: "会议 22:30 开始\nhttps://a.com/x\n- 已有列表：不动\n# 已有标题" },
    ],
  }
  assert.equal(forwardToMarkdown(forward).data,
    "### 提醒\n> 会议 22:30 开始\n> https://a.com/x\n> - 已有列表：不动\n> # 已有标题")

  const mixed = { type: "node", data: [{ message: "状态：正常\n- 已有列表：不动\n**加粗**：不动" }] }
  assert.equal(forwardToMarkdown(mixed).data, "**状态**：正常\n- 已有列表：不动\n\n**加粗**：不动")
})

test("值是 IPv6 网址时放进代码块；已有代码块里的内容原样保留", () => {
  const forward = {
    type: "node",
    data: [
      { message: "外网地址：\n公网 IPv4：1.2.3.4\n公网 IPv6：http://[2406::1]:8080/x" },
      { message: "配置：如下\n```\nkey: value\n如果: 不动\n```\n备注：完" },
      { message: "http://[fe80::1]/y\n说明：单独一行" },
    ],
  }
  assert.equal(forwardToMarkdown(forward).data, [
    "**外网地址**",
    "- **公网 IPv4**：1.2.3.4",
    "- **公网 IPv6**：",
    "```",
    "http://[2406::1]:8080/x",
    "```",
    "",
    "**配置**：如下",
    "```",
    "key: value",
    "如果: 不动",
    "```",
    "**备注**：完",
    "",
    "```",
    "http://[fe80::1]/y",
    "```",
    "**说明**：单独一行",
  ].join("\n"))
})
