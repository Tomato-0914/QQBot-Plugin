/**
 * 官方 Markdown 不支持的写法转换
 *
 * HTML 折叠块 <details><summary>标题</summary>内容</details> 发送会失败，
 * 展开成普通 Markdown：标题加粗单独一行，内容照常显示。代码块、行内代码里的不处理。
 */

const FENCE = /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\2[ \t]*$)/m
const INLINE_CODE = /(`[^`\n]+`)/
const SUMMARY = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i

/** 展开一个折叠块的内部：标题加粗，内容去掉首尾空白 */
function unfold(inner) {
  const summary = inner.match(SUMMARY)
  const title = summary?.[1].trim()
  const body = (summary ? inner.slice(summary[0].length) : inner).trim()
  return [title && `**${title}**`, body].filter(Boolean).join("\n")
}

/** 处理不含代码的文本：由内向外展开嵌套的折叠块，再去掉残留的标签 */
function unfoldText(text) {
  for (let n = 0; n < 20; n++) {
    // 只匹配不含其他 <details 的最内层折叠块
    const next = text.replace(
      /<details\b[^>]*>((?:(?!<details\b)[\s\S])*?)<\/details\s*>/i,
      (match, inner, offset, whole) => {
        // 展开后的块单独占行，不和前后文字粘在一起
        const before = offset > 0 && whole[offset - 1] !== "\n" ? "\n" : ""
        const end = offset + match.length
        const after = end < whole.length && whole[end] !== "\n" ? "\n" : ""
        return `${before}${unfold(inner)}${after}`
      },
    )
    if (next === text) break
    text = next
  }
  return text
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/gi, (_, title) => (title.trim() ? `**${title.trim()}**` : ""))
    .replace(/<\/?(details|summary)\b[^>]*>/gi, "")
}

/** 展开文本中的 HTML 折叠块；没有折叠块时原样返回 */
export function unfoldDetails(text) {
  if (typeof text !== "string" || !/<\/?(details|summary)\b/i.test(text)) return text
  return text
    .split(FENCE)
    .map((part, i) => {
      // split 带两个捕获组：每段代码块后面跟着一个围栏符号分组
      if (i % 3 === 1) return part
      if (i % 3 === 2) return ""
      return part
        .split(INLINE_CODE)
        .map((piece, j) => (j % 2 ? piece : unfoldText(piece)))
        .join("")
    })
    .join("")
}

/** 处理一组待发送的官方消息：Markdown 内容里的折叠块展开 */
export function fixMarkdownMessages(messages) {
  for (const message of messages || [])
    for (const seg of Array.isArray(message) ? message : [message])
      if (seg?.type === "markdown" && typeof seg.data?.content === "string")
        seg.data.content = unfoldDetails(seg.data.content)
  return messages
}
