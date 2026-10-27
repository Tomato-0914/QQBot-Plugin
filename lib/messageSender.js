import { translateToOpenid } from "./uinMap.js"
import { translateGroupToOpenid } from "./groupMap.js"
import { markMsgRecordRecalled, saveMsgRecord } from "./messageStore.js"
import { cacheRemoteFileMessage, cleanupCachedFiles } from "./fileCache.js"
import { sanitizeRawMessage } from "./messageRecord.js"
import { createMaterialScope } from "./material.js"

/** 被动回复限制：同一 msg_id/event_id 最多被动回复的消息条数，超出后自动转为主动消息 */
const REPLY_LIMIT = 5
/** 被动消息有效期，单位毫秒 */
const REPLY_EXPIRE = 300000
/** 被动凭据不可用、回复超限或 SDK 序号重试耗尽时，允许尝试一次主动发送。 */
const PASSIVE_REPLY_FALLBACK_CODES = new Set([
  304103, // 消息 ID 已过期，不能回复
  40034005, // 回复消息 msg_id 已过期
  40034026, // event_id 已过期
  40034027, // 事件不支持回复消息
  40034128, // 被动回复时间或次数超限
  40054005, // SDK 递增序号至 5 后仍冲突
])
/** 记录每个 msg_id/event_id 的截止时间和已使用的被动回复条数 */
const replyCounts = new Map()

function getOpenApiErrorCode (error) {
  const code = Number(
    error?.err_code ??
    error?.code ??
    error?.response?.data?.err_code ??
    error?.response?.data?.code,
  )
  if (Number.isSafeInteger(code)) return code
  const matched = String(error?.message || error).match(/\bcode\((\d+)\)/)
  return matched ? Number(matched[1]) : undefined
}

/** 按 OpenAPI 格式汇总错误；兼容 SDK 包装后的错误说明。 */
function getRequestFailureDetail (error) {
  const message = error?.response?.data?.message ?? String(error?.message || error)
    .replace(/^Request "[^\r\n]*" failed with code\(\d+\): /, "")
  return {
    err_code: getOpenApiErrorCode(error),
    message,
    trace_id: error?.response?.data?.trace_id ?? error?.trace_id,
  }
}

function getReplyKey(self_id, replySeg) {
  const id = replySeg?.data?.id || replySeg?.data?.event_id
  return id ? `${self_id}:${id}` : undefined
}

/** 移除被动回复凭据；引用回复保留 msg_idx，使 SDK 构建主动 message_reference。 */
function makeActiveMessage(message) {
  if (!Array.isArray(message) || message[0]?.type !== "reply") return message
  const [, ...content] = message
  const msgIdx = message[0]?.data?.msg_idx
  if (!msgIdx) return content
  return [{ type: "reply", data: { msg_idx: msgIdx } }, ...content]
}

function getMessageTime (data) {
  for (const value of [data.message_time, data.raw?.timestamp, data.raw?.time, data.time]) {
    if (value === undefined || value === null || value === "") continue
    const number = Number(value)
    const time = Number.isFinite(number)
      ? number > 1e12 ? number : number * 1000
      : Date.parse(value)
    if (Number.isFinite(time) && time > 0) return Math.min(time, Date.now())
  }
  return data._reply_received_at || Date.now()
}

function getReplyState (data, key) {
  const cached = key && replyCounts.get(key)
  if (cached) return cached
  const entry = { count: 0, expiresAt: getMessageTime(data) + REPLY_EXPIRE }
  if (key) {
    replyCounts.set(key, entry)
    const timer = setTimeout(() => {
      if (replyCounts.get(key) === entry) replyCounts.delete(key)
    }, Math.max(REPLY_EXPIRE, entry.expiresAt - Date.now()))
    timer.unref?.()
  }
  return entry
}

function addReplyCount(key) {
  const entry = replyCounts.get(key)
  if (entry) entry.count++
}

function normalizeSentMessage (message) {
  const source = Array.isArray(message) ? message : [message]
  return source.map(segment => {
    if (typeof segment !== "object" || !segment)
      return { type: "text", text: Bot.String(segment) }
    if (typeof segment.data === "object" && segment.data && !Array.isArray(segment.data))
      return { ...segment.data, type: segment.type }
    return { ...segment }
  })
}

function getSentRawMessage (message, brief = "") {
  const source = Array.isArray(message) ? message : [message]
  const raw = source.map(segment => {
    if (typeof segment !== "object" || !segment) return Bot.String(segment)
    switch (segment.type) {
      case "text":
        return segment.data?.text || ""
      case "markdown":
        return segment.data?.content || ""
      case "at":
        return `<@${segment.data?.user_id || ""}>`
      case "face":
        return `<face,id=${segment.data?.id || ""}>`
      case "image":
        return "[图片]"
      case "audio":
        return "[语音]"
      case "video":
        return "[视频]"
      case "file":
        return `[文件：${segment.data?.name || ""}]`
      default:
        return ""
    }
  }).join("")
  return raw || brief
}

export function installMessageSender(adapter) {
  const sendMsgs = async (data, send, fullMsgs, prepareMessage, onSent) => {
    const rets = { message_id: [], data: [], error: [] }

    const recordSent = async (ret, sentMessage, usedReply, replyKey) => {
      Bot.makeLog("debug", ["发送消息返回", ret], data.self_id)
      rets.data.push(ret)
      if (ret.id) rets.message_id.push(ret.id)
      if (usedReply && replyKey) addReplyCount(replyKey)
      if (onSent) {
        try {
          await onSent(ret, sentMessage)
        } catch (err) {
          Bot.makeLog("error", ["已发送消息持久化写入失败", ret, err], data.self_id)
        }
      }
    }

    for (const full of fullMsgs) {
      let prepared = full
      let cachedFiles = []
      if (prepareMessage) {
        try {
          const result = await prepareMessage(full)
          prepared = result.message
          cachedFiles = result.cachedFiles
        } catch (err) {
          Bot.makeLog("error", ["发送文件准备失败", full, err], data.self_id)
          rets.error.push(err)
          continue
        }
      }

      const replyKey = Array.isArray(prepared) && prepared[0]?.type === "reply"
        ? getReplyKey(data.self_id, prepared[0])
        : undefined
      const hasReply = Boolean(replyKey)
      const replyState = hasReply ? getReplyState(data, replyKey) : undefined
      let i = prepared
      let usedReply = hasReply
      let controller
      let deadlineTimer
      if (hasReply && (replyState.count >= REPLY_LIMIT || replyState.expiresAt <= Date.now())) {
        Bot.makeLog("info", "被动回复已过期或达到次数上限，转为主动消息发送", data.self_id)
        i = makeActiveMessage(prepared)
        usedReply = false
      }

      try {
        const options = { timeout: 0 }
        if (usedReply) {
          controller = new AbortController()
          options.signal = controller.signal
          deadlineTimer = setTimeout(() => controller.abort(), Math.max(1, replyState.expiresAt - Date.now()))
        }
        Bot.makeLog("debug", ["发送消息", i], data.self_id)
        const ret = await send(i, options)
        await recordSent(ret, i, usedReply, replyKey)
      } catch (err) {
        Bot.makeLog("debug", ["发送消息失败详情", i, err], data.self_id)
        let replyFailure
        const errorCode = getOpenApiErrorCode(err)
        const isReplyUnavailable = PASSIVE_REPLY_FALLBACK_CODES.has(errorCode)
        if (usedReply && (isReplyUnavailable || controller.signal.aborted || Date.now() >= replyState.expiresAt)) {
          Bot.makeLog("warn", isReplyUnavailable
            ? `被动回复不可用（错误码 ${errorCode}），尝试一次主动消息`
            : "被动回复等待已到5分钟截止时间，尝试一次主动消息", data.self_id)
          replyFailure = getRequestFailureDetail(err)
          try {
            const activeMessage = makeActiveMessage(prepared)
            Bot.makeLog("debug", ["主动发送消息", activeMessage], data.self_id)
            const ret = await send(activeMessage, { timeout: 0 })
            await recordSent(ret, activeMessage, false)
            continue
          } catch (err2) {
            Bot.makeLog("debug", ["主动消息发送失败详情", err2], data.self_id)
            err = err2
          }
        }
        const failure = getRequestFailureDetail(err)
        Bot.makeLog("error", ["发送消息错误", replyFailure
          ? { reply_failure: replyFailure, active_failure: failure }
          : failure], data.self_id)
        rets.error.push(err)
      } finally {
        clearTimeout(deadlineTimer)
        await cleanupCachedFiles(cachedFiles)
      }
    }
    return rets
  }

  adapter.sendMsg = async (data, send, msg, onSent) => {
    const scope = createMaterialScope(data)
    const scopedData = { ...data, _materialScope: scope }
    try {
      const rets = await sendMsgs(
        scopedData,
        send,
        await adapter.converter.makeRawMarkdownMsg(scopedData, msg),
        cacheRemoteFileMessage,
        onSent,
      )
      if (Array.isArray(data._ret_id)) data._ret_id.push(...rets.message_id)
      return rets
    } finally {
      await scope.cleanup()
    }
  }

  adapter.sendFriendMsg = async (data, msg) => {
    const user_id = await translateToOpenid(data.bot || data.self_id, String(data.user_id).replace(`${data.self_id}${adapter.sep}`, ""))
    return adapter.sendMsg(
      { ...data, user_id },
      (msg, options) => data.bot.sdk.sendPrivateMessage(user_id, msg, undefined, options),
      msg,
      (ret, sentMessage) => saveMsgRecord(data.bot || data.self_id, {
        direction: "outgoing",
        scene: "private",
        self_id: data.self_id,
        time: ret.timestamp || ret.time,
        message_id: ret.id,
        msg_idx: ret.ext_info?.ref_idx,
        user_openid: user_id,
        sender: {
          user_openid: String(data.bot.info?.id || data.self_id),
          nickname: data.bot.nickname,
          bot: true,
        },
        message: normalizeSentMessage(sentMessage),
        raw_message: getSentRawMessage(sentMessage, ret.brief),
        raw_request: sanitizeRawMessage(sentMessage),
        raw_response: sanitizeRawMessage(ret),
      }),
    )
  }

  /** 按 QQ OpenAPI 原始请求体发送一个 C2C 流式消息分片。 */
  adapter.sendFriendStreamMsg = async (data, payload, options = {}) => {
    const user_id = await translateToOpenid(
      data.bot || data.self_id,
      String(data.user_id).replace(`${data.self_id}${adapter.sep}`, ""),
    )
    Bot.makeLog("debug", ["发送私聊流式消息", payload], data.self_id)
    const ret = await data.bot.sdk.sendPrivateStreamMessage(user_id, payload, options)
    Bot.makeLog("debug", ["发送私聊流式消息返回", ret], data.self_id)
    // 官方流式接口的正文字段为 content_raw
    const streamContent = String(payload.content_raw ?? payload.content ?? "")
    await saveMsgRecord(data.bot || data.self_id, {
      direction: "outgoing",
      scene: "private",
      self_id: data.self_id,
      time: ret?.timestamp || ret?.time,
      message_id: ret?.id || payload.stream_msg_id,
      user_openid: user_id,
      sender: {
        user_openid: String(data.bot.info?.id || data.self_id),
        nickname: data.bot.nickname,
        bot: true,
      },
      message: streamContent ? [{ type: "text", text: streamContent }] : [],
      raw_message: streamContent,
      raw_request: sanitizeRawMessage({ payload, options }),
      raw_response: sanitizeRawMessage(ret),
    })
    return ret
  }

  adapter.sendGroupMsg = async (data, msg) => {
    let group_id = String(data.group_id).replace(`${data.self_id}${adapter.sep}`, "")
    if (/^\d{5,15}$/.test(group_id)) {
      const openid = await translateGroupToOpenid(data.bot || data.self_id, group_id)
      if (openid) group_id = openid
    }
    const user_id = data.user_id ? await translateToOpenid(data.bot || data.self_id, String(data.user_id).replace(`${data.self_id}${adapter.sep}`, "")) : data.user_id
    return adapter.sendMsg(
      { ...data, group_id, user_id },
      (msg, options) => data.bot.sdk.sendGroupMessage(group_id, msg, undefined, options),
      msg,
      async (ret, sentMessage) => {
        const msgIdx = ret.ext_info?.ref_idx
        await saveMsgRecord(data.bot || data.self_id, {
          direction: "outgoing",
          scene: "group",
          self_id: data.self_id,
          time: ret.timestamp || ret.time,
          msg_idx: msgIdx,
          message_id: ret.id,
          group_openid: group_id,
          sender: {
            user_openid: String(data.bot.info?.id || data.self_id),
            nickname: data.bot.nickname,
            bot: true,
          },
          message: sanitizeRawMessage(normalizeSentMessage(sentMessage)),
          raw_message: getSentRawMessage(sentMessage, ret.brief),
          raw_request: sanitizeRawMessage(sentMessage),
          raw_response: sanitizeRawMessage(ret),
        })
      },
    )
  }

  adapter.sendGMsg = async (data, send, msg) =>
    sendMsgs(data, send, await adapter.converter.makeGuildMsg(data, msg))

  adapter.sendDirectMsg = async (data, msg) => {
    if (!data.guild_id) {
      if (!data.src_guild_id) {
        Bot.makeLog(
          "error",
          [`发送频道私聊消息失败：[${data.user_id}] 不存在来源频道信息`, msg],
          data.self_id,
        )
        return false
      }
      const dms = await data.bot.sdk.createDirectSession(data.src_guild_id, data.user_id)
      data.guild_id = dms.guild_id
      data.channel_id = dms.channel_id
      data.bot.fl.set(`qg_${data.user_id}`, {
        ...data.bot.fl.get(`qg_${data.user_id}`),
        ...dms,
      })
    }
    return adapter.sendGMsg(data, (msg, options) => data.bot.sdk.sendDirectMessage(data.guild_id, msg, undefined, options), msg)
  }

  adapter.sendGuildMsg = (data, msg) => {
    return adapter.sendGMsg(data, (msg, options) => data.bot.sdk.sendGuildMessage(data.channel_id, msg, undefined, options), msg)
  }

  adapter.recallMsg = async (data, recall, message_id) => {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id)
      try {
        msgs.push(await recall(i))
      } catch (err) {
        Bot.makeLog("debug", ["撤回消息错误", i, err], data.self_id)
        msgs.push(false)
      }
    return msgs
  }

  adapter.recallFriendMsg = async (data, message_id) => {
    Bot.makeLog("info", `撤回好友消息：[${data.user_id}] ${message_id}`, data.self_id)
    const userOpenId = await translateToOpenid(
      data.bot || data.self_id,
      String(data.user_id).replace(`${data.self_id}${adapter.sep}`, ""),
    )
    const ids = Array.isArray(message_id) ? message_id : [message_id]
    const rets = await adapter.recallMsg(data, i => data.bot.sdk.recallFriendMessage(userOpenId, i), message_id)
    for (const [idx, ret] of rets.entries())
      if (ret !== false)
        await markMsgRecordRecalled(data.bot || data.self_id, ids[idx], { userOpenId })
    return rets
  }

  adapter.recallGroupMsg = async (data, message_id) => {
    let group_id = String(data.group_id).replace(`${data.self_id}${adapter.sep}`, "")
    if (/^\d{5,15}$/.test(group_id)) {
      const openid = await translateGroupToOpenid(data.bot || data.self_id, group_id)
      if (openid) group_id = openid
    }
    Bot.makeLog("info", `撤回群消息：[${group_id}] ${message_id}`, data.self_id)
    const ids = Array.isArray(message_id) ? message_id : [message_id]
    const rets = await adapter.recallMsg(data, i => data.bot.sdk.recallGroupMessage(group_id, i), message_id)
    // 撤回成功后追加持久化标记，使 getMsg / 引用查询不再返回已撤回的消息。
    for (const [idx, ret] of rets.entries())
      if (ret !== false)
        await markMsgRecordRecalled(data.bot || data.self_id, ids[idx], { groupOpenId: group_id })
    return rets
  }

  adapter.recallDirectMsg = (data, message_id, hide = adapter.config.hideGuildRecall) => {
    Bot.makeLog("info", `撤回${hide ? "并隐藏" : ""}频道私聊消息：[${data.guild_id}] ${message_id}`, data.self_id)
    return adapter.recallMsg(data, i => data.bot.sdk.recallDirectMessage(data.guild_id, i, hide), message_id)
  }

  adapter.recallGuildMsg = (data, message_id, hide = adapter.config.hideGuildRecall) => {
    Bot.makeLog("info", `撤回${hide ? "并隐藏" : ""}频道消息：[${data.channel_id}] ${message_id}`, data.self_id)
    return adapter.recallMsg(data, i => data.bot.sdk.recallGuildMessage(data.channel_id, i, hide), message_id)
  }
}
