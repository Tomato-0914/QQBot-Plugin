/**
 * 文字里的网址转成 Markdown 链接 [文字](网址)
 *
 * 链接文字由 QQBot.yaml 的 linkMarkdownText 决定，{host} 换成网址的域名（去掉 www.），
 * 默认 “🔗 {host}”：比统一写“点击跳转”更能让人看出会打开哪个网站。
 * 已经写成 Markdown 链接 [文字](网址) 或 <网址> 的不处理。
 */

/** 网址：遇到空白、中文标点、引号、尖括号等结束；IPv6 地址写在方括号里，如 http://[fe80::1]:8080/ */
const URL_PATTERN = /https?:\/\/(?:\[[0-9a-f:.]+\])?[^\s<>"'`[\]{}（）【】「」『』《》〈〉，。！？；：、]*/gi
/** 网址末尾的英文标点、Markdown 强调符号属于正文 */
const TRAILING = /[.,!?;:'"~*_]+$/

export const DEFAULT_LINK_TEXT = "🔗 {host}"

const count = (text, char) => text.split(char).length - 1

function trimUrl (url) {
  let result = url.replace(TRAILING, "")
  // 末尾多出来的右括号属于正文，例如“（见 https://a.com/x)”
  while (result.endsWith(")") && count(result, "(") < count(result, ")"))
    result = result.slice(0, -1).replace(TRAILING, "")
  return result
}

/** 链接地址里的括号、空格会提前结束 Markdown 链接 */
const encodeTarget = url =>
  url.replace(/[()\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)

function labelOf (url, template) {
  let host = ""
  try {
    // IPv6 的 hostname 带方括号，去掉
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").replace(/^www\./, "")
  } catch {}
  const text = String(template || DEFAULT_LINK_TEXT)
    .replace(/\{host\}/g, host)
    .replace(/[[\]\r\n]/g, " ")
    .trim()
  return text || host || "链接"
}

/**
 * 文字转成 Markdown：网址换成 [链接文字](网址)，其余部分交给 escape 处理
 * @param {string} text
 * @param {{ linkText?: string, escape?: (text: string) => string }} options
 */
export function linkifyText (text, { linkText = DEFAULT_LINK_TEXT, escape = value => value } = {}) {
  const source = String(text ?? "")
  let output = ""
  let last = 0
  for (const match of source.matchAll(URL_PATTERN)) {
    const start = match.index
    if (start < last) continue
    // 已经是 Markdown 链接：[文字](网址)、[网址](...)、<网址>
    if (source.slice(Math.max(0, start - 2), start) === "](" || source[start - 1] === "<" || source[start - 1] === "[")
      continue
    const url = trimUrl(match[0])
    if (/^https?:\/\/$/i.test(url)) continue
    output += escape(source.slice(last, start)) + `[${labelOf(url, linkText)}](${encodeTarget(url)})`
    last = start + url.length
  }
  return output + escape(source.slice(last))
}
