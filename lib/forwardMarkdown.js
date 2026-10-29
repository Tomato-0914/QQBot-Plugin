/**
 * 纯文字的合并转发改成一条 Markdown
 *
 * 官方机器人发不了合并转发，原本交给野生号发（没有野生号时拆成多条消息）。
 * 只有文字的合并转发（如 AI 的思考过程、各种列表）直接转成一条 Markdown：
 * 标题加粗，每个节点一段引用块。带图片、文件等其他内容，或文字过长时仍按原方式处理。
 * wild-silence.json 中 forwardMarkdown: false 可关闭。
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

/** 节点内容转文字；含有文字以外的内容时返回 null */
function textOf(message) {
  if (message == null) return ""
  if (typeof message !== "object") return String(message)
  if (Array.isArray(message)) {
    const parts = message.map(textOf)
    return parts.includes(null) ? null : parts.join("")
  }
  switch (message.type) {
    case "text":
      return String(message.text ?? message.data?.text ?? "")
    case "markdown": {
      const data = message.data ?? message.content
      return String(typeof data === "string" ? data : data?.content ?? "")
    }
    case "node": {
      const texts = nodesOf(message).map(node => textOf(node?.message))
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

/** 一个合并转发消息段转成 Markdown 消息段；不能转换时返回 null */
function nodeToMarkdown(seg) {
  const texts = nodesOf(seg).map(node => textOf(node?.message ?? node?.content))
  if (!texts.length || texts.includes(null)) return null
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_LENGTH) return null

  let title = typeof seg.title === "string" ? seg.title.trim() : ""
  let body = texts.filter(t => t.trim())
  if (!body.length) return null
  if (!title && body.length > 1 && !body[0].includes("\n") && body[0].trim().length <= TITLE_LENGTH) {
    title = body[0].trim()
    body = body.slice(1)
  }
  const content = body.map(quote).join("\n\n")
  return { type: "markdown", data: title ? `**${title}**\n${content}` : content }
}

/** 消息里纯文字的合并转发换成 Markdown，其余内容不变；没有可转换的内容时原样返回 */
export function forwardToMarkdown(msg) {
  const segs = Array.isArray(msg) ? msg : [msg]
  let changed = false
  const out = segs.map(seg => {
    if (seg?.type !== "node") return seg
    const md = nodeToMarkdown(seg)
    if (!md) return seg
    changed = true
    return md
  })
  if (!changed) return msg
  return Array.isArray(msg) ? out : out[0]
}
