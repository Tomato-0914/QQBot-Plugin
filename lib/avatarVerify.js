import crypto from "node:crypto"

/**
 * QQ 头像校验：比对官方机器人 openid 的头像和 QQ 号的头像是否为同一张
 * #QQ绑定 与自动绑定共用
 */
const JPEG_SOI = 0xD8
const JPEG_SOS = 0xDA
const JPEG_EOI = 0xD9
const JPEG_APP11 = 0xEB
const QQ_AVATAR_APP11_TOTAL_LENGTH = 596
const QQ_AVATAR_APP11_MAGIC = "fae93b12"

async function fetchAvatar (url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "curl/8.0.0",
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  })
  if (!res.ok) throw new Error(`头像获取失败：${res.status} ${res.statusText} ${url}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (!buffer.length) return false
  const md5 = crypto.createHash("md5").update(buffer).digest("hex")
  Bot.makeLog?.("debug", ["QQBot 头像MD5", url, md5, buffer.length])
  // X-Info：real data = 自定义头像；real-sysimg-* = 系统默认头像
  return { buffer, md5, info: res.headers.get("x-info") || "" }
}

function parseJpegHeader (buffer) {
  if (buffer.length < 4 ||
    buffer[0] !== 0xFF || buffer[1] !== JPEG_SOI ||
    buffer[buffer.length - 2] !== 0xFF || buffer[buffer.length - 1] !== JPEG_EOI) return false

  const segments = []
  let offset = 2
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xFF) return false

    while (offset < buffer.length && buffer[offset] === 0xFF) offset++
    if (offset >= buffer.length) return false

    const marker = buffer[offset]
    const markerOffset = offset - 1
    offset++

    // TEM、RST0-RST7 不包含长度字段。
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      segments.push({ marker, offset: markerOffset, totalLength: 2 })
      continue
    }

    if (offset + 2 > buffer.length) return false
    const length = buffer.readUInt16BE(offset)
    if (length < 2) return false

    const end = offset + length
    if (end > buffer.length) return false

    const segment = {
      marker,
      offset: markerOffset,
      totalLength: length + 2,
      payloadStart: offset + 2,
      payloadEnd: end,
    }
    segments.push(segment)

    if (marker === JPEG_SOS) return { segments }
    offset = end
  }

  return false
}

function getQqAvatarApp11 (buffer, jpeg) {
  const sosIndex = jpeg.segments.findIndex(segment => segment.marker === JPEG_SOS)
  if (sosIndex < 1) return false

  const app11 = jpeg.segments[sosIndex - 1]
  if (app11.marker !== JPEG_APP11 || app11.totalLength !== QQ_AVATAR_APP11_TOTAL_LENGTH) return false

  const payload = buffer.subarray(app11.payloadStart, app11.payloadEnd)
  if (!(payload.length === 592 &&
    payload.readUInt32BE(0) === 1 &&
    payload.subarray(4, 8).toString("hex") === QQ_AVATAR_APP11_MAGIC &&
    payload.readUInt32BE(20) === 568)) return false

  return app11
}

function getJpegHeader (buffer, jpeg, ignoredSegment) {
  const sos = jpeg.segments.find(segment => segment.marker === JPEG_SOS)
  if (!sos) return false

  const headerEnd = sos.offset + sos.totalLength
  if (!ignoredSegment) return buffer.subarray(0, headerEnd)
  if (ignoredSegment.offset >= sos.offset) return false

  return Buffer.concat([
    buffer.subarray(0, ignoredSegment.offset),
    buffer.subarray(ignoredSegment.offset + ignoredSegment.totalLength, headerEnd),
  ])
}

function isCompatibleQqJpeg (openidBuffer, uinBuffer) {
  const openidJpeg = parseJpegHeader(openidBuffer)
  const uinJpeg = parseJpegHeader(uinBuffer)
  if (!openidJpeg || !uinJpeg) return false

  const app11 = getQqAvatarApp11(uinBuffer, uinJpeg)
  if (!app11) return false

  const openidHeader = getJpegHeader(openidBuffer, openidJpeg)
  const uinHeader = getJpegHeader(uinBuffer, uinJpeg, app11)
  return !!openidHeader && !!uinHeader && openidHeader.equals(uinHeader)
}

/**
 * 校验头像，返回 { ok, custom }
 * custom 表示 QQ 号用的是自定义头像；默认头像人人相同，校验通过也不能说明是同一个人
 */
export async function checkAvatar (appid, openid, uin) {
  const qqbotAvatar = `https://thirdqq.qlogo.cn/qqapp/${appid}/${openid}/640`
  const qqAvatar = `https://q.qlogo.cn/g?b=qq&nk=${uin}&s=640`
  const [openidAvatar, uinAvatar] = await Promise.all([
    fetchAvatar(qqbotAvatar),
    fetchAvatar(qqAvatar),
  ])
  if (!openidAvatar || !uinAvatar) return { ok: false, custom: false }
  const custom = uinAvatar.info === "real data"
  if (openidAvatar.md5 === uinAvatar.md5) return { ok: true, custom }

  const isCompatibleJpeg = isCompatibleQqJpeg(openidAvatar.buffer, uinAvatar.buffer)
  Bot.makeLog?.("debug", [
    "QQBot JPEG头像兼容校验",
    `openidSize=${openidAvatar.buffer.length}`,
    `uinSize=${uinAvatar.buffer.length}`,
    `sizeDelta=${uinAvatar.buffer.length - openidAvatar.buffer.length}`,
    `result=${isCompatibleJpeg}`,
  ])
  return { ok: isCompatibleJpeg, custom }
}

export async function verifyAvatar (appid, openid, uin) {
  return (await checkAvatar(appid, openid, uin)).ok
}
