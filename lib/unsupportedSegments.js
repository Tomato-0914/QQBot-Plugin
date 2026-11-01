/**
 * 官方机器人发不了的消息段
 *
 * json / xml 卡片、链接分享改成 Markdown 链接（取卡片里的标题和跳转地址），没有地址时发 “[卡片] 标题”；
 * 位置改成文字；戳一戳、窗口抖动、匿名、骰子、猜拳等只有 QQ 客户端才有的消息段直接去掉。
 * 原本这些消息段会被当成一段 JSON 文字发出去。
 * 其他插件可以通过扩展接口（adapter.use 的 send）先把它们交给别的账号发送，没发出去的才会到这里。
 */

/** 只有 QQ 客户端才有、官方机器人没有对应消息的消息段，直接去掉 */
const DROP = new Set(["poke", "shake", "anonymous", "dice", "rps", "contact"])

/** Markdown 链接文字里的 [ ] 会提前闭合链接，去掉 */
const linkText = text => String(text ?? "").replace(/[[\]\r\n]/g, " ").replace(/\s+/g, " ").trim()

/** 链接里的括号、空格会提前结束 Markdown 链接 */
const linkUrl = url =>
  String(url).replace(/[()\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)

const isHttp = url => typeof url === "string" && /^https?:\/\//i.test(url)

const decodeXml = text => String(text ?? "")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, "&")

/** 消息段的数据：OneBot 格式放在 data 里，icqq 格式直接放在消息段上 */
const dataOf = seg => (seg.data && typeof seg.data === "object" && !Array.isArray(seg.data) ? seg.data : seg)

/** json 卡片：QQ 小程序、链接分享卡片的标题和跳转地址在 meta 里 */
function jsonCard(seg) {
  let raw = seg.data
  if (raw && typeof raw === "object" && typeof raw.data === "string" && !raw.meta && !raw.app) raw = raw.data
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!raw || typeof raw !== "object") return {}
  const meta = raw.meta && typeof raw.meta === "object"
    ? Object.values(raw.meta).find(value => value && typeof value === "object")
    : undefined
  return {
    title: meta?.title || meta?.desc || raw.prompt,
    url: [meta?.qqdocurl, meta?.jumpUrl, meta?.jump_url, meta?.url].find(isHttp),
  }
}

/** xml 卡片：跳转地址在 msg 的 url 属性里，标题在 title 或 brief 里 */
function xmlCard(seg) {
  const data = dataOf(seg)
  const xml = String(typeof seg.data === "string" ? seg.data : data.data ?? "")
  const attr = name => xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
  const title = xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || attr("brief")
  const url = decodeXml(attr("url"))
  return { title: decodeXml(title), url: isHttp(url) ? url : undefined }
}

/** 卡片转成 Markdown 链接，没有地址时转成文字；什么都取不到返回 null */
function cardSegment({ title, url }, fallback = "卡片") {
  if (url) return { type: "markdown", data: `🔗 [${linkText(title) || fallback}](${linkUrl(url)})` }
  const text = String(title ?? "").replace(/\s+/g, " ").trim()
  if (text) return { type: "text", text: `[${fallback}] ${text}` }
  return null
}

function convert(seg) {
  switch (seg.type) {
    case "json":
      return cardSegment(jsonCard(seg))
    case "xml":
      return cardSegment(xmlCard(seg))
    case "share": {
      const data = dataOf(seg)
      return cardSegment({ title: data.title || data.content, url: isHttp(data.url) ? data.url : undefined }, "链接")
    }
    case "location": {
      const data = dataOf(seg)
      const text = [data.name || data.title, data.address || data.content].filter(Boolean).join(" ")
      return { type: "text", text: `[位置]${text ? ` ${text}` : ""}` }
    }
    default:
      return null
  }
}

/** 合并转发的节点列表，兼容 data 直接是数组和 data.data 两种写法 */
function mapNodes(seg) {
  const fix = node => (node && typeof node === "object" && node.message !== undefined
    ? { ...node, message: fixUnsupportedSegments(node.message) }
    : node)
  if (Array.isArray(seg.data)) return { ...seg, data: seg.data.map(fix) }
  if (Array.isArray(seg.data?.data)) return { ...seg, data: { ...seg.data, data: seg.data.data.map(fix) } }
  return seg
}

/** 消息里官方机器人发不了的消息段换成能发的内容或去掉；没有要处理的内容时原样返回 */
export function fixUnsupportedSegments(msg) {
  const segs = Array.isArray(msg) ? msg : [msg]
  let changed = false
  const out = []
  for (const seg of segs) {
    if (!seg || typeof seg !== "object") {
      out.push(seg)
      continue
    }
    if (seg.type === "node") {
      const fixed = mapNodes(seg)
      if (fixed !== seg) changed = true
      out.push(fixed)
      continue
    }
    if (DROP.has(seg.type)) {
      changed = true
      continue
    }
    if (seg.type === "json" || seg.type === "xml" || seg.type === "share" || seg.type === "location") {
      changed = true
      const converted = convert(seg)
      if (converted) out.push(converted)
      continue
    }
    out.push(seg)
  }
  if (!changed) return msg
  return Array.isArray(msg) ? out : out[0] ?? []
}
