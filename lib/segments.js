/**
 * 官方机器人额外的消息段构造器，注册到全局 segment（已有同名构造器时不覆盖）
 *
 *   segment.card(data)                           图文卡片（msg_type 8），见 lib/card.js
 *   segment.bubble(...buttons)                   气泡按钮：显示在输入框上方，最多 3 个，写法同 segment.button
 *   segment.small()                              本条消息的按钮使用小号字体
 *   segment.qqbotcmd(text, input, enter, reply)  Markdown 指令文字：点击后把 input 填入输入框，enter 为 true 时直接发送
 *   segment.inlinecmd(text, input, enter, reply) 旧版 mqqapi 指令链接，效果同上
 *   segment.link(text, url)                      Markdown 跳转链接
 *   segment.ark(template_id, data)               ark 模板消息，支持 23 / 24 / 37；也可用 segment.ark23 / ark24 / ark37
 *
 * qqbotcmd、inlinecmd、link 返回 Markdown 消息段，和文字放在同一个数组里发送即可。
 */

const markdown = data => ({ type: "markdown", data })

const attr = value => encodeURIComponent(String(value ?? ""))

export function bubble (...data) {
  return { type: "bubble", data }
}

export function small () {
  return { type: "small" }
}

export function card (data) {
  return { type: "card", ...data }
}

export function qqbotcmd (text, input = text, enter = false, reply = false) {
  return markdown(enter
    ? `<qqbot-cmd-enter text="${attr(input)}" />`
    : `<qqbot-cmd-input text="${attr(input)}" show="${attr(text)}" reference="${reply === true}" />`)
}

export function inlinecmd (text, input = text, enter = false, reply = false) {
  return markdown(`[${text}](mqqapi://aio/inlinecmd?command=${attr(input)}&enter=${enter === true}&reply=${reply === true})`)
}

export function link (text, url) {
  return markdown(`[🔗${text}](${url})`)
}

/* ---------- ark 模板 ---------- */

const str = value => (typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "")

/** 取 data 里的字段，兼容 meta_title / metaTitle / metatitle 这类写法 */
function pick (data, ...names) {
  const keys = Object.keys(data)
  for (const name of names) {
    const flat = name.replace(/_/g, "").toLowerCase()
    const key = keys.find(k => k.replace(/_/g, "").toLowerCase() === flat)
    if (key !== undefined) return data[key]
  }
}

function listItems (list) {
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map(item => {
    let desc, url
    if (typeof item === "string") desc = item
    else if (Array.isArray(item)) [desc, url] = item
    else {
      desc = item.desc ?? item.text
      url = item.link ?? item.url
    }
    const obj_kv = [{ key: "desc", value: str(desc) }]
    if (str(url)) obj_kv.push({ key: "link", value: str(url) })
    return { obj_kv }
  })
}

const ARK_FIELDS = {
  // 23：文字列表，list 每项为文字、[文字, 链接] 或 { desc, link }
  23: data => [
    ["#DESC#", pick(data, "desc")],
    ["#PROMPT#", pick(data, "prompt")],
    ["#LIST#", listItems(pick(data, "list")), "obj"],
  ],
  // 24：大图卡片
  24: data => [
    ["#DESC#", pick(data, "desc")],
    ["#PROMPT#", pick(data, "prompt")],
    ["#TITLE#", pick(data, "title")],
    ["#METADESC#", pick(data, "metadesc")],
    ["#IMG#", pick(data, "img")],
    ["#LINK#", pick(data, "link")],
    ["#SUBTITLE#", pick(data, "subtitle")],
  ],
  // 37：大图通知，封面建议 975×540
  37: data => [
    ["#PROMPT#", pick(data, "prompt")],
    ["#METATITLE#", pick(data, "metatitle")],
    ["#METASUBTITLE#", pick(data, "metasubtitle")],
    ["#METACOVER#", pick(data, "metacover")],
    ["#METAURL#", pick(data, "metaurl")],
  ],
}

export function ark (template_id, data = {}) {
  const id = Number(template_id)
  const fields = ARK_FIELDS[id]
  if (!fields) throw new Error(`ark 模板 ${template_id} 不支持，可选 23 / 24 / 37`)
  const kv = fields(data).map(([key, value, type]) => (type === "obj" ? { key, obj: value } : { key, value: str(value) }))
  return { type: "ark", template_id: id, kv }
}

export const ark23 = data => ark(23, data)
export const ark24 = data => ark(24, data)
export const ark37 = data => ark(37, data)

const BUILDERS = { card, bubble, buble: bubble, small, qqbotcmd, inlinecmd, link, ark, ark23, ark24, ark37 }

/** 注册到全局 segment；其他插件或适配器已经定义的同名构造器保持不变 */
export function installSegments (segment = globalThis.segment) {
  if (!segment) return
  for (const [name, fn] of Object.entries(BUILDERS))
    if (typeof segment[name] !== "function") segment[name] = fn
}
