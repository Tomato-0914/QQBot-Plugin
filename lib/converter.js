import { ulid } from "ulid"
import * as imageSizeModule from "image-size"
import cfg from "../../../lib/config/config.js"
import { compressImage } from "./utils.js"
import { getAppid, getMappedUin, isQQUin, translateToOpenid } from "./uinMap.js"
import { getRecordByMsgId, parseSceneExt } from "./messageStore.js"

const imageSize = imageSizeModule.imageSize || imageSizeModule.default || imageSizeModule

export class Converter {
  constructor (adapter) {
    this.adapter = adapter
  }

  // 语音发送（原生格式，不转 silk）
  async makeRecord (file) {
    if (this.adapter.config.toBotUpload)
      for (const i of Bot.uin) {
        if (!Bot[i].uploadRecord) continue
        try {
          const url = await Bot[i].uploadRecord(file)
          if (url) return url
        } catch (err) {
          Bot.makeLog("error", ["Bot", i, "语音上传错误", file, err])
        }
      }

    const buffer = await Bot.Buffer(file)
    if (!Buffer.isBuffer(buffer)) return file

    // silk/wav/mp3/flac 等格式原生发送，不再强制转码为 silk
    return buffer
  }

  // 转义 Markdown 文本中的特殊字符
  makeRawMarkdownText (text) {
    return text.replace(/@/g, "@​").replace(/<qqbot-/g, "<qqbot-​")
  }

  // 处理 Markdown 图片
  async makeMarkdownImage (data, file, summary = "图片") {
    let buffer = await Bot.Buffer(file)
    if (!Buffer.isBuffer(buffer)) throw new Error("无法读取 Markdown 图片内容")
    if (this.adapter.config.imageLength) {
      buffer = await compressImage(buffer, this.adapter.config.imageLength * 1024 * 1024,
        (level, message) => Bot.makeLog(level, [message], data.self_id))
    }
    // 压缩可能改变编码，文件名、MIME 和宽高均以最终字节内容为准。
    const size = imageSize(buffer)
    if (!data._materialScope) throw new Error("Markdown 图片必须通过发送入口管理临时素材")
    const image = await data._materialScope.uploadImage(buffer, size.type)

    return {
      des: `![${summary} #${size.width || 0}px #${size.height || 0}px]`,
      url: `(${image.url})`,
    }
  }

  async makeReply (reply, data, quote = false) {
    if (!reply) return reply
    if (reply.data?.id?.startsWith?.("event_")) {
      if (data?.raw?.event_id) return { type: "reply", data: { event_id: data.raw.event_id } }
      return false
    }
    if (reply.data?.id?.startsWith?.("INTERACTION_CREATE:")) {
      const event_id = reply.data.id.replace(/^INTERACTION_CREATE:/, "")
      if (data?.raw?.event_id === event_id) return { type: "reply", data: { event_id } }
      return false
    }
    if (!quote || !reply.data?.id || reply.data.msg_idx) return reply

    let msgIdx
    if (reply.data.id === data.message_id)
      msgIdx = data.msg_idx || data.raw?.msg_idx || parseSceneExt(data.raw).msg_idx
    else {
      const scope = data._raw_group_id
        ? { groupOpenId: data._raw_group_id }
        : data._raw_user_id
          ? { userOpenId: data._raw_user_id }
          : undefined
      msgIdx = (await getRecordByMsgId(data.bot || data.self_id, reply.data.id, scope))?.msg_idx
    }

    if (msgIdx)
      return { ...reply, data: { ...reply.data, msg_idx: msgIdx } }
    return reply
  }

  // 构建一个按钮消息段
  async makeButton (data, button, style) {
    const msg = {
      id: ulid(),
      render_data: {
        label: button.text,
        visited_label: button.clicked_text,
        style,
        ...button.QQBot?.render_data,
      },
    }

    if (button.input)
      msg.action = {
        type: 2,
        permission: { type: 2 },
        data: button.input,
        enter: button.send,
        ...button.QQBot?.action,
      }
    else if (button.callback) {
      msg.action = {
        type: 1,
        permission: { type: 2 },
        ...button.QQBot?.action,
      }
      if (!Array.isArray(data._ret_id)) data._ret_id = []
      data.bot.callback[msg.id] = {
        id: data.message_id,
        user_id: data.user_id,
        group_id: data.group_id,
        message: button.callback,
        message_id: data._ret_id,
      }
      setTimeout(() => delete data.bot.callback[msg.id], 300000)
    } else if (button.link)
      msg.action = {
        type: 0,
        permission: { type: 2 },
        data: button.link,
        ...button.QQBot?.action,
      }
    else return false

    // 私聊场景忽略 permission 字段：私聊只有一个对话者，permission 无实际意义，
    // 且传入后会导致手机端显示"无权限"，PC端正常，属于QQ官方API的客户端差异化bug。
    if (button.permission && data.group_id) {
      if (button.permission === "admin") {
        msg.action.permission.type = 1
      } else {
        let permission = button.permission
        if (permission === "master")
          permission = cfg.master[String(data.self_id)] || []

        msg.action.permission.type = 0
        msg.action.permission.specify_user_ids = []
        if (!Array.isArray(permission)) permission = [permission]
        for (const id of permission) {
          const stripped = String(id).replace(`${data.self_id}${this.adapter.sep}`, "")
          const openid = await translateToOpenid(data.bot || data.self_id, stripped)
          msg.action.permission.specify_user_ids.push(openid)
        }
      }
    }
    return msg
  }

  // 将按钮数组转换为 button 消息段数组
  async makeButtons (data, button_square) {
    // 兼容多种写法：
    // segment.button({ ... })                  单个按钮
    // segment.button([{ ... }, { ... }])       一行多个按钮
    // segment.button([{ ... }], [{ ... }])     多行按钮
    // segment.button([[{ ... }], [{ ... }]])   旧文档中的二维数组写法
    if (!Array.isArray(button_square)) button_square = [[button_square]]
    else if (button_square.length === 1 && Array.isArray(button_square[0]) && Array.isArray(button_square[0][0])) button_square = button_square[0]
    else if (button_square.length && !Array.isArray(button_square[0])) button_square = [button_square]

    const msgs = [],
      random = Math.floor(Math.random() * 2)
    for (let button_row of button_square) {
      if (!Array.isArray(button_row)) button_row = [button_row]
      const buttons = []
      for (let button of button_row) {
        button = await this.makeButton(data, button, (random + msgs.length + buttons.length) % 2)
        if (button) buttons.push(button)
      }
      if (buttons.length) msgs.push({ type: "button", data: { buttons } })
    }
    return msgs
  }

  hasNativeImageMixedContent (msg) {
    if (this.adapter.config.markdownImage === true) return false
    const state = { image: false, content: false }
    const scan = value => {
      if (Array.isArray(value)) {
        for (const item of value) scan(item)
        return
      }
      if (value == null) return
      if (typeof value !== "object") {
        if (Bot.String(value).trim()) state.content = true
        return
      }

      switch (value.type) {
        case "image":
          state.image = true
          break
        case "text":
          if (String(value.text ?? value.data?.text ?? "").trim()) state.content = true
          break
        case "markdown":
        case "at":
        case "file":
          state.content = true
          break
        case "node":
          for (const item of value.data?.data || []) scan(item.message)
          break
      }
    }

    scan(msg)
    return state.image && state.content
  }

  normalizeSendableSegment (i) {
    if (typeof i === "object") return { type: i.type, data: { ...i, type: undefined } }
    return { type: "text", data: { text: Bot.String(i) } }
  }

  markdownDataToText (data) {
    const markdown = data?.data
    if (typeof markdown === "string") return markdown
    if (markdown?.content) return markdown.content
    return Bot.String(markdown || "")
  }

  // 非 Markdown 消息里的 @成员：已绑定时显示 QQ 号，未绑定时显示昵称，都没有则省略
  async makeAtText (data, qq) {
    const bot = data.bot || Bot[data.self_id]
    const uin = isQQUin(qq) ? qq : await getMappedUin(getAppid(bot), qq)
    if (uin) return `@${uin}`
    const name = bot?.fl?.get(qq)?.nickname
    return name ? `@${name}` : ""
  }

  async makeNativeRichMsg (data, msg, nested) {
    const messages = [],
      button = []
    let message = [],
      reply,
      hasMedia = false

    const pushMessage = () => {
      if (!message.length) return
      messages.push(message)
      message = []
      hasMedia = false
    }

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      i = this.normalizeSendableSegment(i)

      switch (i.type) {
        case "record":
          i.type = "audio"
          i.data.file = await this.makeRecord(i.data.file)
        case "video":
        case "image":
          if (hasMedia) pushMessage()
          if (i.type === "image" && this.adapter.config.imageLength && i.data.file) {
            const buf = await Bot.Buffer(i.data.file, { http: true })
            if (Buffer.isBuffer(buf))
              i.data.file = await compressImage(buf, this.adapter.config.imageLength * 1024 * 1024,
                (level, message) => Bot.makeLog(level, [message], data.self_id))
          }
          message.push(i)
          hasMedia = true
          break
        case "at": {
          if (data.message_type === "private") continue
          const qq = String(i.data.qq ?? i.data.user_id ?? "").replace(`${data.self_id}${this.adapter.sep}`, "")
          // 群聊里 @成员 标签只在 Markdown 消息中生效，原生图文消息里会原样显示，改为可读文字；
          // @全体成员 文本消息也支持，保留为真实提及
          if (qq === "all") message.push({ type: "at", data: { user_id: "all" } })
          else {
            const text = await this.makeAtText(data, qq)
            if (text) message.push({ type: "text", data: { text } })
          }
          break
        }
        case "text":
          if (i.data.text) message.push({ type: "text", data: { text: i.data.text } })
          break
        case "markdown": {
          const text = this.markdownDataToText(i.data)
          if (text) message.push({ type: "text", data: { text } })
          break
        }
        case "file":
          if (hasMedia) pushMessage()
          message.push(i)
          hasMedia = true
          break
        case "button":
          button.push(...await this.makeButtons(data, i.data.data))
          break
        case "reply":
          reply = i
          continue
        case "node":
          pushMessage()
          for (const { message } of i.data.data)
            messages.push(...(await this.makeNativeRichMsg(data, message, true)))
          continue
        case "raw":
          pushMessage()
          messages.push(Array.isArray(i.data.data) ? i.data.data : [i.data.data])
          break
        default:
          message.push(i)
      }
    }

    pushMessage()

    if (button.length) {
      for (const i of messages) {
        i.push(...button.splice(0, 5))
        if (!button.length) break
      }
      while (button.length)
        messages.push([{ type: "text", data: { text: " " } }, ...button.splice(0, 5)])
    }

    const quote = Boolean(reply)
    if (!reply && !nested && data.message_id) reply = { type: "reply", data: { id: data.message_id } }
    reply = await this.makeReply(reply, data, quote)
    if (reply) {
      for (const i of messages)
        i.unshift(reply)
    }
    return messages
  }
  // Raw Markdown 消息组装
  async makeRawMarkdownMsg (data, msg, nested) {
    if (this.hasNativeImageMixedContent(msg))
      return this.makeNativeRichMsg(data, msg, nested)
    const messages = [],
      button = []
    let content = "",
      reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { type: i.type, data: { ...i, type: undefined } }
      else i = { type: "text", data: { text: Bot.String(i) } }

      switch (i.type) {
        case "record":
          i.type = "audio"
          i.data.file = await this.makeRecord(i.data.file)
        case "video":
        case "face":
        case "ark":
        case "embed":
          messages.push([i])
          break
        case "file":
          messages.push([i])
          break
        case "at": {
          if (data.message_type === "private") continue
          if (i.data.qq === "all") content += "<qqbot-at-everyone />"
          else {
            const qq = String(i.data.qq ?? "").replace(`${data.self_id}${this.adapter.sep}`, "")
            const openid = await translateToOpenid(data.bot || data.self_id, qq)
            content += `<qqbot-at-user id="${openid}" />`
          }
          break
        }
        case "text":
          content += this.makeRawMarkdownText(i.data.text)
          break
        case "image": {
          if (this.adapter.config.markdownImage === true) {
            const { des, url } = await this.makeMarkdownImage(data, i.data.file, i.data.summary)
            content += `${des}${url}`
          } else if (i.type === "image" && this.adapter.config.imageLength && i.data.file) {
            const buf = await Bot.Buffer(i.data.file, { http: true })
            if (Buffer.isBuffer(buf))
              i.data.file = await compressImage(buf, this.adapter.config.imageLength * 1024 * 1024,
                (level, message) => Bot.makeLog(level, [message], data.self_id))
            messages.push([i])
          } else {
            messages.push([i])
          }
          break
        }
        case "markdown":
          if (typeof i.data.data === "object") {
            const markdown = { ...i.data.data }
            if (this.adapter.config.forceVerifyImageResource === true)
              markdown.force_verify_image_resource = true
            else
              delete markdown.force_verify_image_resource
            messages.push([{ type: "markdown", data: markdown }])
          }
          else content += i.data.data
          break
        case "button":
          button.push(...await this.makeButtons(data, i.data.data))
          break
        case "reply":
          reply = i
          continue
        case "node":
          for (const { message } of i.data.data)
            messages.push(...(await this.makeRawMarkdownMsg(data, message, true)))
          continue
        case "raw":
          messages.push(Array.isArray(i.data.data) ? i.data.data : [i.data.data])
          break
        default:
          content += this.makeRawMarkdownText(Bot.String(i))
      }
    }

    if (content) {
      const markdown = {
        type: "markdown",
        data: {
          content,
          ...(this.adapter.config.forceVerifyImageResource === true
            ? { force_verify_image_resource: true }
            : {}),
        },
      }
      const markdownMessage = [markdown]
      messages.unshift(markdownMessage)
    }

    if (button.length) {
      for (const i of messages) {
        if (i[0].type === "markdown") i.push(...button.splice(0, 5))
        if (!button.length) break
      }
      while (button.length)
        messages.push([{ type: "markdown", data: { content: " " } }, ...button.splice(0, 5)])
    }

    const quote = Boolean(reply)
    if (!reply && !nested && data.message_id) reply = { type: "reply", data: { id: data.message_id } }
    reply = await this.makeReply(reply, data, quote)
    if (reply) {
      for (const i in messages) {
        if (Array.isArray(messages[i])) messages[i].unshift(reply)
        else messages[i] = [reply, messages[i]]
      }
    }
    return messages
  }


  async makeMsg (data, msg, nested) {
    const messages = [],
      button = []
    let message = [],
      reply

    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { type: i.type, data: { ...i, type: undefined } }
      else i = { type: "text", data: { text: Bot.String(i) } }

      switch (i.type) {
        case "at":
          //i.data.user_id = i.data.qq?.replace?.(`${data.self_id}${this.adapter.sep}`, "")
          continue
        case "text":
          if (!i.data.text || !i.data.text.trim()) continue
          break
        case "face":
        case "ark":
        case "embed":
          break
        case "record":
          i.type = "audio"
          i.data.file = await this.makeRecord(i.data.file)
        case "video":
        case "image":
          if (message.length) {
            messages.push(message)
            message = []
          }

          if (i.type === "image" && this.adapter.config.imageLength && i.data.file) {
            const buf = await Bot.Buffer(i.data.file, { http: true })
            if (Buffer.isBuffer(buf))
              i.data.file = await compressImage(buf, this.adapter.config.imageLength * 1024 * 1024,
                (level, message) => Bot.makeLog(level, [message], data.self_id))
          }
          break
        case "file":
          if (message.length) {
            messages.push(message)
            message = []
          }
          break
        case "reply":
          reply = i
          continue
        case "markdown":
          if (typeof i.data.data === "object") i = { type: "markdown", data: i.data.data }
          else i = { type: "markdown", data: { content: i.data.data } }
          break
        case "button":
          //button.push(...this.makeButtons(data, i.data.data))
          continue
        case "node":
          for (const { message } of i.data.data)
            messages.push(...(await this.makeMsg(data, message, true)))
          continue
        case "raw":
          if (Array.isArray(i.data.data)) {
            messages.push(i.data.data)
            continue
          }
          i = i.data.data
          break
        default:
          i = { type: "text", data: { text: Bot.String(i) } }
      }

      message.push(i)
    }

    if (message.length) messages.push(message)

    while (button.length)
      messages.push([
        {
          type: "keyboard",
          content: { rows: button.splice(0, 5) },
        },
      ])

    const quote = Boolean(reply)
    if (!reply && !nested && data.message_id) reply = { type: "reply", data: { id: data.message_id } }
    reply = await this.makeReply(reply, data, quote)
    if (reply)
      for (const i of messages)
        i.unshift(reply)
    return messages
  }

  // 频道消息转换
  async makeGuildMsg (data, msg, nested) {
    const messages = []
    let message = [],
      reply
    for (let i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") i = { type: i.type, data: { ...i, type: undefined } }
      else i = { type: "text", data: { text: Bot.String(i) } }

      switch (i.type) {
        case "at": {
          const qq = String(i.data.qq ?? "").replace(/^qg_/, "")
          i.data.user_id = await translateToOpenid(data.bot || data.self_id, qq)
          break
        }
        case "text":
        case "face":
        case "ark":
        case "embed":
          break
        case "image":
          message.push(i)
          messages.push(message)
          message = []
          continue
        case "record":
        case "video":
        case "file":
          if (i.data.file) i.data.file = await Bot.fileToUrl(i.data.file, i)
          i = { type: "text", data: { text: `文件：${i.data.file}` } }
          break
        case "reply":
          reply = i
          continue
        case "markdown":
          if (typeof i.data.data === "object") i = { type: "markdown", data: { ...i.data.data } }
          else i = { type: "markdown", data: { content: i.data.data } }
          delete i.data.force_verify_image_resource
          break
        case "button":
          continue
        case "node":
          for (const { message } of i.data.data)
            messages.push(...(await this.makeGuildMsg(data, message, true)))
          continue
        case "raw":
          if (Array.isArray(i.data.data)) {
            messages.push(i.data.data)
            continue
          }
          i = i.data.data
          break
        default:
          i = { type: "text", data: { text: Bot.String(i) } }
      }

      message.push(i)
    }

    if (message.length) messages.push(message)
    const quote = Boolean(reply)
    if (!reply && !nested && data.message_id) reply = { type: "reply", data: { id: data.message_id } }
    reply = await this.makeReply(reply, data, quote)
    if (reply)
      for (const i of messages)
        i.unshift(reply)
    return messages
  }
}
