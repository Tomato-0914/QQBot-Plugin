import assert from "node:assert/strict"
import { test } from "node:test"
import { musicToMarkdown } from "../lib/musicMarkdown.js"

// Run with: node --test test/musicMarkdown.test.js
// 官方机器人发不了的音乐卡片改成 Markdown 链接

test("自定义音乐卡片：歌名 - 歌手 链接到歌曲页面", () => {
  const card = {
    type: "music",
    data: {
      type: "custom",
      url: "https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html",
      audio: "http://c6.y.qq.com/rsc/fcgi-bin/fcg_pyq_play.fcg?songmid=0039MnYb0qxYhV",
      title: "晴天",
      content: "周杰伦",
      image: "http://y.gtimg.cn/a.jpg",
    },
  }
  assert.deepEqual(musicToMarkdown(card), {
    type: "markdown",
    data: "🎵 [晴天 - 周杰伦](https://y.qq.com/n/yqq/song/0039MnYb0qxYhV.html)",
  })
})

test("平台 + 歌曲 id 的卡片按平台拼出歌曲页面；icqq 的平铺写法也能识别", () => {
  assert.equal(musicToMarkdown({ type: "music", data: { type: "163", id: "186016" } }).data,
    "🎵 [网易云音乐](https://music.163.com/#/song?id=186016)")
  assert.equal(musicToMarkdown({ type: "music", platform: "qq", id: 97773 }).data,
    "🎵 [QQ 音乐](https://i.y.qq.com/v8/playsong.html?songid=97773)")
})

test("歌名里的方括号、链接里的括号和空格不会破坏 Markdown 链接", () => {
  const md = musicToMarkdown({ type: "music", data: { type: "custom", url: "https://a.com/x (live)", title: "[Live] 晴天" } })
  assert.equal(md.data, "🎵 [Live  晴天](https://a.com/x%20%28live%29)")
})

test("缺少链接的卡片、其他消息段保持不变；消息数组里只替换音乐卡片", () => {
  const noUrl = { type: "music", data: { type: "custom", title: "无链接" } }
  assert.equal(musicToMarkdown(noUrl), noUrl)
  assert.equal(musicToMarkdown("文字"), "文字")
  const msg = ["点歌：", { type: "music", data: { type: "custom", url: "https://a.com/s", title: "歌" } }]
  assert.deepEqual(musicToMarkdown(msg), ["点歌：", { type: "markdown", data: "🎵 [歌](https://a.com/s)" }])
  const plain = ["a", { type: "image", file: "x.png" }]
  assert.equal(musicToMarkdown(plain), plain)
})
