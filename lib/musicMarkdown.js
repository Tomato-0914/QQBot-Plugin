/**
 * 音乐卡片转成 Markdown 链接
 *
 * 官方机器人发不了音乐卡片，平时交给同群的野生号发送（lib/wildCardRelay.js）。
 * 没有野生号、或野生号也发送失败时，卡片会回到官方机器人这边，原本会被当成一段 JSON 文字发出去；
 * 这里改成一条 Markdown 链接：🎵 [歌名 - 歌手](歌曲页面)。
 */

/** 各平台按歌曲 id 打开歌曲页面的地址 */
const SONG_PAGE = {
  qq: id => `https://i.y.qq.com/v8/playsong.html?songid=${encodeURIComponent(id)}`,
  163: id => `https://music.163.com/#/song?id=${encodeURIComponent(id)}`,
  kugou: id => `https://www.kugou.com/song/#hash=${encodeURIComponent(id)}`,
  migu: id => `https://music.migu.cn/v3/music/song/${encodeURIComponent(id)}`,
  kuwo: id => `https://www.kuwo.cn/play_detail/${encodeURIComponent(id)}`
}

const PLATFORM = { qq: "QQ 音乐", 163: "网易云音乐", kugou: "酷狗音乐", migu: "咪咕音乐", kuwo: "酷我音乐" }

/** Markdown 链接文字里的 [ ] 会提前闭合链接，去掉 */
const linkText = text => String(text ?? "").replace(/[[\]\r\n]/g, " ").trim()

/** 音乐消息段转成 Markdown 消息段；信息不足时返回 null */
function toMarkdown(seg) {
  // OneBot 格式 { type: "music", data: { type: 平台, ... } }；icqq 格式字段直接放在消息段上，平台为 platform
  const nested = seg.data && typeof seg.data === "object"
  const data = nested ? seg.data : seg
  const platform = String((nested ? data.type : seg.platform ?? seg.subType) ?? "")
  let url = data.url || data.jumpUrl || (data.id != null && SONG_PAGE[platform]?.(data.id))
  if (!url || !/^https?:\/\//i.test(url)) return null
  // 链接里的括号、空格会提前结束 Markdown 链接
  url = url.replace(/[()\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
  const title = linkText(data.title) || PLATFORM[platform] || "分享的歌曲"
  const singer = linkText(data.content ?? data.singer)
  return { type: "markdown", data: `🎵 [${singer ? `${title} - ${singer}` : title}](${url})` }
}

/** 消息里的音乐卡片换成 Markdown 链接，其余内容不变；没有可转换的内容时原样返回 */
export function musicToMarkdown(msg) {
  const segs = Array.isArray(msg) ? msg : [msg]
  let changed = false
  const out = segs.map(seg => {
    if (seg?.type !== "music") return seg
    const md = toMarkdown(seg)
    if (!md) return seg
    changed = true
    return md
  })
  if (!changed) return msg
  return Array.isArray(msg) ? out : out[0]
}
