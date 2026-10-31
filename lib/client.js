import { Bot as QQBot, ReceiverMode } from "qq-official-bot"
import { applyUinMapping, getAppid, getMappedUin } from "./uinMap.js"
import { getGroupUin } from "./groupMap.js"
import { makeMessage } from "./messageBuilder.js"
import { getRecordByMsgId } from "./messageStore.js"
import { makeStreamReplyPayload } from "./streamMessage.js"

export async function makeGroupMemberNotice (adapter, id, event) {
  const action = event.sub_type === "member.increase"
    ? "increase"
    : event.sub_type === "member.decrease"
      ? "decrease"
      : undefined
  if (!action) return false

  const rawGroupId = event.group_id
  const rawUserId = event.user_id
  if (!rawGroupId || !rawUserId) {
    Bot.makeLog("warn", ["群成员通知缺少必要字段", event], id)
    return false
  }

  const bot = Bot[id]
  const appid = getAppid(bot)
  const mappedGroupId = await getGroupUin(bot || id, rawGroupId)
  const mappedUserId = await getMappedUin(appid, rawUserId)
  const rawOperatorId = event.operator_id
  const mappedOperatorId = rawOperatorId && await getMappedUin(appid, rawOperatorId)
  const data = {
    raw: event,
    bot,
    self_id: id,
    post_type: "notice",
    notice_type: "group",
    sub_type: action,
    sdk_sub_type: event.sub_type,
    event_id: event.event_id,
    notice_id: event.notice_id || event.event_id,
    time: event.time,
    group_id: mappedGroupId || rawGroupId,
    _raw_group_id: rawGroupId,
    user_id: mappedUserId || rawUserId,
    _raw_user_id: rawUserId,
    sender: {
      user_id: mappedUserId || rawUserId,
      _raw_user_id: rawUserId,
    },
  }

  if (rawOperatorId) {
    data.operator_id = mappedOperatorId || rawOperatorId
    data._raw_operator_id = rawOperatorId
  }

  // 群消息的 event_id 被动回复只支持 INTERACTION_CREATE、GROUP_ADD_ROBOT、GROUP_MSG_RECEIVE，
  // 群成员增减事件不在其中，直接按主动消息发送。
  data.reply = msg => adapter.sendGroupMsg(
    {
      ...data,
      group_id: rawGroupId,
      user_id: rawUserId,
    },
    msg,
  )

  const actionText = action === "increase" ? "增加" : "减少"
  const operatorText = data.operator_id ? `${data.operator_id} => ` : ""
  Bot.makeLog(
    "info",
    `群成员${actionText}：${operatorText}${data.user_id}`,
    `${data.self_id} <= ${data.group_id}`,
    true,
  )
  Bot.em(`notice.group.${action}`, data)
  return data
}

/** 好友新增来源 scene 中，开发者生成的分享链接（站内 / 站外） */
const SHARE_LINK_SCENES = new Set([2003, 2004])

/**
 * 好友新增 / 减少转成 Yunzai 的 notice.friend.increase / decrease 事件；
 * 用户通过分享链接添加时，e.callback_data 为生成链接时传入的数据
 */
export async function makeFriendNotice (adapter, id, event) {
  const action = event.sub_type
  if (action !== "increase" && action !== "decrease") return false
  const rawUserId = event.user_id
  if (!rawUserId) {
    Bot.makeLog("warn", ["好友通知缺少必要字段", event], id)
    return false
  }

  const bot = Bot[id]
  const mappedUserId = await getMappedUin(getAppid(bot), rawUserId)
  const scene = Number(event.scene) || undefined
  const data = {
    raw: event,
    bot,
    self_id: id,
    post_type: "notice",
    notice_type: "friend",
    sub_type: action,
    event_id: event.event_id,
    // 好友新增事件可以用 event_id 被动回复
    message_id: event.event_id ? `event_${event.event_id}` : undefined,
    time: event.time,
    user_id: mappedUserId || rawUserId,
    _raw_user_id: rawUserId,
    sender: { user_id: mappedUserId || rawUserId, _raw_user_id: rawUserId },
    scene,
    scene_param: event.scene_param || "",
    callback_data: SHARE_LINK_SCENES.has(scene) ? event.scene_param || "" : "",
  }
  if (action === "increase")
    data.reply = msg => adapter.sendFriendMsg({ ...data, user_id: rawUserId }, msg)

  const from = data.callback_data ? `（分享链接：${data.callback_data}）` : ""
  Bot.makeLog("info", `好友${action === "increase" ? "增加" : "减少"}：${data.user_id}${from}`, data.self_id, true)
  Bot.em(`notice.friend.${action}`, data)
  return data
}

/** 入群申请的验证信息转成一段文字：填写的验证消息，或问答题的问题和回答 */
export function joinRequestComment (verifyInfo) {
  if (!verifyInfo) return ""
  const lines = []
  if (verifyInfo.verify_message) lines.push(verifyInfo.verify_message)
  for (const qa of verifyInfo.review_qa_list || [])
    lines.push(`问题：${qa.question ?? ""}\n答案：${qa.answer ?? ""}`)
  return lines.join("\n")
}

/**
 * 入群申请转成 Yunzai 的 request.group.add 事件，插件用 e.approve(true/false) 处理；
 * 需要机器人是群管理员，flag 为 join_request_id
 */
export async function makeGroupJoinRequest (adapter, id, event) {
  const rawGroupId = event.group_id
  const rawUserId = event.user_id
  if (!rawGroupId || !rawUserId) {
    Bot.makeLog("warn", ["入群申请缺少必要字段", event], id)
    return false
  }

  const bot = Bot[id]
  const appid = getAppid(bot)
  const mappedGroupId = await getGroupUin(bot || id, rawGroupId)
  const mappedUserId = await getMappedUin(appid, rawUserId)
  const comment = joinRequestComment(event.verify_info)
  const data = {
    raw: event,
    bot,
    self_id: id,
    post_type: "request",
    request_type: "group",
    sub_type: event.invited_by ? "invite" : "add",
    event_id: event.event_id,
    time: event.time,
    group_id: mappedGroupId || rawGroupId,
    _raw_group_id: rawGroupId,
    user_id: mappedUserId || rawUserId,
    _raw_user_id: rawUserId,
    nickname: event.user_name,
    sender: {
      user_id: mappedUserId || rawUserId,
      _raw_user_id: rawUserId,
      nickname: event.user_name,
    },
    comment,
    flag: event.join_request_id,
    join_request_id: event.join_request_id,
    verify_info: event.verify_info,
    apply_source: event.apply_source,
    invited_by: event.invited_by,
  }

  /** 同意或拒绝这条申请；block 为 true 时拒绝并加入群黑名单 */
  data.approve = (approve = true, reason = "", block = false) =>
    bot.sdk.setGroupJoinRequest(rawGroupId, rawUserId, approve, {
      join_request_id: event.join_request_id,
      reject_reason: reason,
      add_to_blacklist: block,
    })
  // 入群申请不在 event_id 可被动回复的事件里，直接按主动消息发送
  data.reply = msg => adapter.sendGroupMsg({ ...data, group_id: rawGroupId, user_id: rawUserId }, msg)

  Bot.makeLog(
    "info",
    `入群申请：${data.nickname ? `${data.nickname}(${data.user_id})` : data.user_id}${comment ? ` ${comment.replace(/\n/g, " ")}` : ""}`,
    `${data.self_id} <= ${data.group_id}`,
    true,
  )
  Bot.em(`request.group.${data.sub_type}`, data)
  return data
}

export async function connectBot (adapter, token) {
  token = token.split(":")
  const id = token[0]
  const opts = {
    mode: ReceiverMode.WEBSOCKET,
    removeAt: false,
    ...adapter.config.bot,
    appid: token[1],
    token: token[2],
    secret: token[3],
    intents: [
      "GUILDS",
      "GUILD_MEMBERS",
      "GUILD_MESSAGE_REACTIONS",
      "DIRECT_MESSAGE",
      "INTERACTION",
      "MESSAGE_AUDIT",
    ],
  }
  if (+token[4]) opts.intents.push("GROUP_AND_C2C_EVENT", "GROUP_MEMBER")
  if (Number(token[5])) opts.intents.push("GUILD_MESSAGES")
  else opts.intents.push("PUBLIC_GUILD_MESSAGES")
  Bot[id] = {
    adapter,
    sdk: new QQBot(opts),
    login () {
      return this.sdk.start()
    },
    logout () {
      return this.sdk.stop()
    },
    uin: id,
    info: {
      id,
      ...opts,
      // ✅ 修正：将 this.uin 改为 id
      avatar: `https://q.qlogo.cn/g?b=qq&s=0&nk=${id}`,
    },
    get nickname () {
      return this.info.username
    },
    get avatar () {
      return this.info.avatar
    },
    version: {
      id: adapter.id,
      name: adapter.name,
      version: adapter.version,
    },
    stat: { start_time: Date.now() / 1000 },
    pickFriend: user_id => adapter.pickFriend(id, user_id),
    get pickUser () {
      return this.pickFriend
    },
    getFriendMap () {
      return adapter.getFriendMap(id)
    },
    fl: await adapter.getFriendMap(id),
    pickMember: (group_id, user_id) => adapter.pickMember(id, group_id, user_id),
    pickGroup: group_id => adapter.pickGroup(id, group_id),
    getGroupInfo: (group_id, no_cache, add) =>
      adapter.pickGroup(id, group_id).getInfo(no_cache, add),
    get_group_info: (group_id, no_cache, add) =>
      adapter.pickGroup(id, group_id).getInfo(no_cache, add),
    getGroupMap () {
      return adapter.getGroupMap(id)
    },
    gl: await adapter.getGroupMap(id),
    gml: await adapter.getMemberMap(id),
    /** 从本地 JSONL 消息记录查询消息；撤回后由追加的标记使查询返回 false。 */
    getMsg: async message_id => await getRecordByMsgId(id, message_id) || false,
    /** 生成机器人的分享链接；用户通过链接添加机器人时，好友新增事件的 e.callback_data 为这里传入的数据（最长 32 个字符） */
    getGenerateUrl: callback_data => Bot[id].sdk.getGenerateUrl(callback_data),
    callback: {},
  }
  Bot[id].sdk.logger = {}
  for (const i of ["trace", "debug", "info", "mark", "warn", "error", "fatal"])
    Bot[id].sdk.logger[i] = (...args) => {
      if (
        args[0]?.startsWith?.("recv from") ||
        args[0]?.startsWith?.("[CLIENT]") ||
        args[0]?.includes?.("点击了消息按钮") ||
        [
          "[WebSocketReceiver] 服务端要求重连",
          "[WebSocketReceiver] 连接关闭：连接过期，请重连",
          "[WebSocketReceiver] 重连成功",
        ].includes(args[0]) ||
        /^\[WebSocketReceiver\] 连接断开，第\d+次重连\.\.\.$/.test(args[0])
      ) return
      return Bot.makeLog(i, args, id)
    }

  try {
    await Bot[id].login()
    Object.assign(Bot[id].info, await Bot[id].sdk.getSelfInfo())
  } catch (err) {
    Bot.makeLog("error", [`${adapter.name}(${adapter.id}) ${adapter.version} 连接失败`, err], id)
    return false
  }

  const makeCallback = async (id, event) => {
    const reply = event.reply.bind(event)
    event.reply = async (...args) => {
      try {
        return await reply(...args)
      } catch (err) {
        Bot.makeLog("debug", ["回复按钮点击事件错误", err], id)
      }
    }

    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "message",
      message_id: event.event_id ? `event_${event.event_id}` : event.notice_id,
      _reply_received_at: Date.now(),
      message_type: event.notice_type,
      sub_type: "callback",
      get user_id () {
        return this.sender.user_id
      },
      sender: { user_id: event.operator_id, _raw_user_id: event.operator_id },
      message: [],
      raw_message: "",
    }

    const callback = data.bot.callback[event.data?.resolved?.button_id]
    if (callback) {
      if (!event.group_id && callback.group_id) event.group_id = callback.group_id
      if (callback.message_id.length) {
        for (const id of callback.message_id) data.message.push({ type: "reply", id })
        data.raw_message += `[回复：${callback.message_id}]`
      }
      data.message.push({ type: "text", text: callback.message })
      data.raw_message += callback.message
    } else {
      if (event.data?.resolved?.button_id) {
        data.message.push({ type: "reply", id: event.data?.resolved?.button_id })
        data.raw_message += `[回复：${event.data?.resolved?.button_id}]`
      }
      // 消息按钮回调带 button_data；单聊快捷菜单（type=12）只带管理端设置的 feature_id
      const callbackText = event.data?.resolved?.button_data || event.data?.resolved?.feature_id
      if (callbackText) {
        data.message.push({ type: "text", text: callbackText })
        data.raw_message += callbackText
      } else {
        event.reply(1)
      }
    }
    event.reply(0)

    // 用户 UIN 映射：将 operator_id(openid) 解析为真实 QQ 号
    if (event.operator_id && data.message_type !== "guild") {
      data._raw_user_id = event.operator_id
      await applyUinMapping(data, event.operator_id)
    }

    switch (data.message_type) {
      case "friend":
        data.message_type = "private"
        Bot.makeLog("info", [`好友按钮点击事件：[${data.user_id}] [${event.data?.resolved?.button_id}] ${data.raw_message}`], data.self_id)

        data.reply = msg => adapter.sendFriendMsg({ ...data, user_id: event.operator_id }, msg)
        data.streamReply = (payload, options) => adapter.sendFriendStreamMsg(
          { ...data, user_id: event.operator_id },
          makeStreamReplyPayload(payload, { ...data, event_id: event.event_id }),
          options,
        )
        adapter.setFriendMap(data)
        break
      case "group": {
        const callbackGroupOpenid = event.group_id
        data.group_id = callbackGroupOpenid
        data._raw_group_id = callbackGroupOpenid
        // 群映射：将 group_openid 解析为真实群号
        const callbackRealGroupUin = await getGroupUin(data.bot || data.self_id, callbackGroupOpenid)
        if (callbackRealGroupUin) {
          data.group_id = callbackRealGroupUin
        }
        Bot.makeLog(
          "info",
          [`群按钮点击事件：[${data.group_id}, ${data.user_id}] [${event.data?.resolved?.button_id}] ${data.raw_message}`],
          data.self_id,
        )

        data.reply = msg => adapter.sendGroupMsg({ ...data, group_id: callbackGroupOpenid, user_id: event.operator_id }, msg)
        adapter.setGroupMap(data)
        break
      }
      case "guild": {
        data.message_type = "group"
        if (!event.guild_id && callback?.group_id?.startsWith?.("qg_")) {
          const [guild_id, channel_id] = callback.group_id.replace(/^qg_/, "").split("-")
          event.guild_id = guild_id
          event.channel_id = channel_id
        }
        data.group_id = `qg_${event.guild_id}-${event.channel_id}`
        data.sender = {
          ...data.bot.fl.get(`qg_${event.operator_id}`),
          user_id: `qg_${event.operator_id}`,
          src_guild_id: event.guild_id,
          src_channel_id: event.channel_id,
        }
        Bot.makeLog(
          "info",
          [`频道按钮点击事件：[${data.group_id}, ${data.user_id}] [${event.data?.resolved?.button_id}] ${data.raw_message}`],
          data.self_id,
        )

        data.reply = msg => adapter.sendGuildMsg({ ...data, guild_id: event.guild_id, channel_id: event.channel_id }, msg)
        adapter.setFriendMap(data)
        adapter.setGroupMap(data)
        break
      }
      default:
        Bot.makeLog("warn", ["未知按钮点击事件", event], data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  const makeNotice = async (id, event) => {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: event.post_type,
      notice_type: event.notice_type,
      sub_type: event.sub_type,
      notice_id: event.notice_id,
    }

    switch (data.sub_type) {
      case "action":
        return makeCallback(id, event)
      case "increase":
      case "decrease":
        if (event.notice_type === "friend") return makeFriendNotice(adapter, id, event)
        return makeGroupMemberNotice(adapter, id, event)
      case "update":
      case "member.increase":
      case "member.decrease":
        return makeGroupMemberNotice(adapter, id, event)
      case "request":
        return makeGroupJoinRequest(adapter, id, event)
      case "member.update":
        break
      default:
        Bot.makeLog("warn", ["未知通知", event], id)
        return
    }

    //Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
  }

  // ✅ 精准监听：避开 message.audit.pass/reject（它们无 .message 数组）
  for (const eventName of ["message.private", "message.group", "message.guild"])
    Bot[id].sdk.on(eventName, async event => {
      try {
        await makeMessage(adapter, id, event)
      } catch (err) {
        Bot.makeLog("error", ["处理消息事件失败", eventName, err], id)
      }
    })
  Bot[id].sdk.on("notice", event => {
    void makeNotice(id, event).catch(err =>
      Bot.makeLog("error", ["处理通知事件失败", event, err], id),
    )
  })

  Bot.makeLog("mark", `${adapter.name}(${adapter.id}) ${adapter.version} ${Bot[id].nickname} 已连接`, id)
  Bot.em(`connect.${id}`, { self_id: id })
  return true
}
