/**
 * 图文卡片（msg_type 8）：标题、描述、封面图，点击打开链接
 *
 * 插件里发送：segment.card({ title, description, pic_url, url })，
 * 或 { type: "card", title, description, pic_url, url }
 *   - title、description 超过 50 字截断
 *   - url 必须是 https 链接，会追加 qq_aio_chat_type=3 让链接在 QQ 内打开
 *   - pic_url 为 http(s) 图片链接
 */

const MAX_TEXT = 50

const clip = text => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`)

function withAioParam (url) {
  if (/[?&]qq_aio_chat_type=/.test(url)) return url
  return `${url}${url.includes("?") ? "&" : "?"}qq_aio_chat_type=3`
}

/**
 * Yunzai 的 card 消息段转成开放平台的 card 字段
 * @param {{ title: string, description: string, pic_url?: string, image?: string, url: string }} data
 * @returns {{ type: "card", data: { type: "tuwen", content: object } }}
 */
export function makeCardElement (data = {}) {
  const title = String(data.title ?? "").trim()
  const description = String(data.description ?? data.desc ?? "").trim()
  const picUrl = String(data.pic_url ?? data.image ?? "").trim()
  const url = String(data.url ?? data.jumpUrl ?? "").trim()
  if (!title || !description || !picUrl || !url)
    throw new Error("图文卡片的 title、description、pic_url、url 均为必填")
  if (!url.startsWith("https://")) throw new Error("图文卡片的 url 必须是 https 链接")
  if (!/^https?:\/\//.test(picUrl)) throw new Error("图文卡片的 pic_url 必须是 http(s) 图片链接")

  return {
    type: "card",
    data: {
      type: "tuwen",
      content: {
        title: clip(title),
        description: clip(description),
        pic_url: picUrl,
        url: withAioParam(url),
      },
    },
  }
}

