/**
 * 纯文字的合并转发改成一条 Markdown
 *
 * 官方机器人发不了合并转发，原本只能拆成多条消息发送。
 * 只有文字的合并转发（如 AI 的思考过程、各种列表）直接转成一条 Markdown：
 * 第一行短句做小标题；纯文字的节点各成一段引用块；含有“分段标题：”“键：值”的节点逐行排版
 * （分段标题加粗，分段标题下的键值行变成列表，键都加粗，“如果… / 注意…”等提示放进引用块）。
 * 带图片、文件等其他内容，或文字过长时仍按原方式处理。
 * 在群聊、私聊发送入口调用（lib/extensions.js），QQBot.yaml 中 forwardMarkdown: false 可关闭。
 */

/** 超过这个字数仍按合并转发处理，避免单条 Markdown 过长发送失败 */
export const MAX_LENGTH = 3000
/** 第一个节点不超过这个字数、且只有一行时当作标题 */
const TITLE_LENGTH = 20

/** 合并转发消息段的节点列表 */
function nodesOf(seg) {
  if (Array.isArray(seg.data)) return seg.data
  if (Array.isArray(seg.data?.data)) return seg.data.data
  return []
}

/** 节点内容转文字；含有文字以外的内容时返回 null。linkify 处理文字段（网址转链接），Markdown 段原样保留 */
function textOf(message, linkify = text => text) {
  if (message == null) return ""
  if (typeof message !== "object") return linkify(String(message))
  if (Array.isArray(message)) {
    const parts = message.map(part => textOf(part, linkify))
    return parts.includes(null) ? null : parts.join("")
  }
  switch (message.type) {
    case "text":
      return linkify(String(message.text ?? message.data?.text ?? ""))
    case "markdown": {
      const data = message.data ?? message.content
      return String(typeof data === "string" ? data : data?.content ?? "")
    }
    case "node": {
      const texts = nodesOf(message).map(node => textOf(node?.message, linkify))
      return texts.includes(null) ? null : texts.join("\n")
    }
    case "reply":
    case "button":
      return ""
    default:
      return null
  }
}

const quote = text =>
  text
    .trim()
    .split("\n")
    .map(line => (line.trim() ? `> ${line}` : ">"))
    .join("\n")

/** 已经是 Markdown 写法的行（标题、列表、引用、代码块、表格），原样保留 */
const MARKDOWN_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|>|\d+[.)]\s|```|\|)/
/** 分段标题：短标签 + 冒号结尾，如“内网地址：” */
const SECTION = /^([^\s#>*`|[\]()][^：:[\]()]{0,14}?)\s*[：:]$/
/** 键值行：短标签 + 冒号 + 内容，如“网卡 eth0：10.1.0.7”；半角冒号后要有空格，避免把时间、网址当成键值 */
const KEY_VALUE = /^([^\s#>*`|[\]()][^：:[\]()]{0,11}?)\s*(?:：|:\s)\s*(\S.*)$/
/** 提示、说明类的行，放进引用块 */
const HINT = /^(?:如果|若|注意|请注意|提示|温馨提示|说明|备注|tips?\b)/i

const isStructured = line =>
  !MARKDOWN_LINE.test(line) && (SECTION.test(line.trim()) || KEY_VALUE.test(line.trim()))

/**
 * 一行排版，返回 { kind, text }：kind 为 list / quote / text
 * inSection：前面有分段标题时，键值行做成列表；单独的键值行写成“**键**：值”，
 * 免得和上一个节点的列表连成一个列表
 */
function formatLine(line, inSection = false) {
  const text = line.trim()
  if (!text) return { kind: "blank", text: "" }
  if (MARKDOWN_LINE.test(line)) {
    const kind = /^\s*(?:[-*+]|\d+[.)])\s/.test(line) ? "list" : /^\s*>/.test(line) ? "quote" : "text"
    return { kind, text: line }
  }
  let match = text.match(SECTION)
  if (match) return { kind: "text", text: `**${match[1]}**` }
  match = text.match(KEY_VALUE)
  if (match)
    return inSection
      ? { kind: "list", text: `- **${match[1]}**：${match[2]}` }
      : { kind: "text", text: `**${match[1]}**：${match[2]}` }
  if (HINT.test(text)) return { kind: "quote", text: `> ${text}` }
  return { kind: "text", text }
}

/**
 * 含有分段标题、键值行的节点逐行排版：分段标题加粗，分段标题下的键值行变成列表（键加粗），
 * 单独的键值行键加粗，提示放进引用块；
 * 列表、引用后面接其他内容时空一行，避免被并进上一块
 */
function formatStructured(text) {
  const out = []
  let previous
  let inSection = false
  for (const line of text.trim().split("\n")) {
    const { kind, text: formatted } = formatLine(line, inSection)
    if (!MARKDOWN_LINE.test(line) && SECTION.test(line.trim())) inSection = true
    if (kind === "blank") {
      if (out.length && out.at(-1) !== "") out.push("")
      previous = undefined
      continue
    }
    if (previous && previous !== kind && (previous === "list" || previous === "quote") && out.at(-1) !== "")
      out.push("")
    out.push(formatted)
    previous = kind
  }
  return out.join("\n").trim()
}

/** 节点排版：有结构（分段标题、键值行）的逐行排版，纯文字的整段放进引用块 */
const formatNode = text => (text.split("\n").some(isStructured) ? formatStructured(text) : quote(text))

/** 标题末尾的句号去掉 */
const cleanTitle = title => title.trim().replace(/[。.]+$/, "")

/** 一个合并转发消息段转成 Markdown 消息段；不能转换时返回 null */
function nodeToMarkdown(seg, linkify) {
  const texts = nodesOf(seg).map(node => textOf(node?.message ?? node?.content, linkify))
  if (!texts.length || texts.includes(null)) return null
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_LENGTH) return null

  let title = typeof seg.title === "string" ? seg.title.trim() : ""
  let body = texts.filter(t => t.trim())
  if (!body.length) return null
  if (!title && body.length > 1) {
    const [firstLine, ...rest] = body[0].trim().split("\n")
    const structured = body.some(text => text.split("\n").some(isStructured))
    // 第一个节点只有一行短句时当作标题；有结构的消息（如地址、配置列表）第一个节点多行时取第一行
    if (firstLine.trim().length <= TITLE_LENGTH && !isStructured(firstLine) && (!rest.length || structured)) {
      title = firstLine
      body = rest.join("\n").trim() ? [rest.join("\n"), ...body.slice(1)] : body.slice(1)
    }
  }
  const content = body.map(formatNode).join("\n\n")
  return { type: "markdown", data: title ? `### ${cleanTitle(title)}\n${content}` : content }
}

/** 消息里纯文字的合并转发换成 Markdown，其余内容不变；没有可转换的内容时原样返回 */
export function forwardToMarkdown(msg, { linkify } = {}) {
  const segs = Array.isArray(msg) ? msg : [msg]
  let changed = false
  const out = segs.map(seg => {
    if (seg?.type !== "node") return seg
    const md = nodeToMarkdown(seg, linkify)
    if (!md) return seg
    changed = true
    return md
  })
  if (!changed) return msg
  return Array.isArray(msg) ? out : out[0]
}
