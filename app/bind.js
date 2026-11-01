import {
  getAppid,
  isQQUin,
  isGuildUserId,
  saveMapping,
} from "../lib/uinMap.js"
import cfg from "../../../lib/config/config.js"
import { verifyAvatar } from "../lib/avatarVerify.js"

function isMaster (data) {
  return !!(data.user_id && cfg.master[data.self_id]?.includes(String(data.user_id)))
}

function getCommandText (data) {
  const text = data.message
    ?.filter(item => item.type === "text")
    .map(item => item.text || "")
    .join("")
    .trim()
  return text || String(data.raw_message || "").trim()
}

function getMentionTargets (data) {
  const botIds = new Set([
    data.self_id,
    data.bot?.uin,
    data.bot?.info?.id,
  ].filter(Boolean).map(String))
  const targets = new Map()

  for (const item of data.message || []) {
    const isSelf = item.is_you === true || item.is_you === "true"
    if (item.type !== "at" || isSelf) continue
    const openid = String(item._raw_user_id || item.user_id || item.qq || "")
    if (!openid || openid === "all" || isGuildUserId(openid) || botIds.has(openid)) continue
    targets.set(openid, {
      openid,
      name: item.username || "",
    })
  }

  return [...targets.values()]
}

async function handleMasterBind (data, appid, target, uin, force) {
  if (!force) {
    await data.reply("正在校验被@用户...")
    const ok = await verifyAvatar(appid, target.openid, uin)
    if (!ok) {
      await data.reply([
        "代绑定失败：被@用户与真实QQ不符合。",
        "可使用 #QQ强制绑定 或 #QQ强制绑定openid 进行强制绑定。",
      ].join("\n"))
      return
    }
  }

  const saved = await saveMapping(appid, target.openid, uin)
  if (!saved) {
    await data.reply("代绑定失败：映射保存失败，请检查 Redis。")
    return
  }

  const targetName = target.name ? `${target.name} ` : ""
  const action = force ? "强制代绑定" : "代绑定"
  Bot.makeLog?.("info", [
    `QQBot ${action}成功`,
    `operator=${data.user_id}`,
    `target=${target.openid}`,
    `uin=${uin}`,
  ], data.self_id)
  await data.reply(`${action}成功：${targetName}${uin}`)
}

/**
 * 绑定命令处理（独立 app，通过 Bot.em 事件驱动）
 *
 *   #QQ绑定                 → 显示帮助 + 输入按钮（点击自动填入 #QQ绑定 ）
 *   #QQ绑定<QQ号>           → 头像 MD5 校验 → 双向映射 (Redis + JSON)
 *   #QQ绑定@用户 <QQ号>     → master 校验目标头像后代绑定
 *   #QQ强制绑定@用户 <QQ号> → master 跳过头像校验直接代绑定
 *   #QQ绑定openid <openid> <QQ号>     → master 校验目标头像后直接绑定
 *   #QQ强制绑定openid <openid> <QQ号> → master 跳过头像校验直接绑定
 *   #QQ解绑                 → TODO
 */
async function handleBindMessage (data) {
  const targetIds = ['QQBot']
  if (!targetIds.includes(data.bot?.adapter?.id)) return

  const rawOpenid = data._raw_user_id || data.sender?.user_id
  if (!rawOpenid || isGuildUserId(rawOpenid)) return

  const appid = getAppid(data.bot || data.self_id)
  const text = String(data.raw_message || "").trim()
  const commandText = getCommandText(data)
  const mentionTargets = getMentionTargets(data)

  // --- master 使用已知 openid 直接绑定 ---
  const openidBindPrefix = /^#QQ(?:强制)?绑定openid\b/i
  if (openidBindPrefix.test(commandText)) {
    if (!isMaster(data)) {
      Bot.makeLog?.("debug", [
        `QQBot 非master openid绑定忽略: user_id=${data.user_id} self_id=${data.self_id}`,
      ], data.self_id)
      return
    }

    const openidBindMatch = commandText.match(
      /^#QQ(强制)?绑定openid\s+([a-f0-9]{32})\s+(\d{5,12})\s*$/i,
    )
    if (!openidBindMatch) {
      await data.reply(
        "命令格式错误，例如：#QQ绑定openid 32位OPENID 123456",
      )
      return
    }

    const force = !!openidBindMatch[1]
    const targetOpenid = openidBindMatch[2]
    const uin = openidBindMatch[3]
    try {
      await handleMasterBind(data, appid, {
        openid: targetOpenid,
        name: `openid ${targetOpenid}`,
      }, uin, force)
    } catch (err) {
      Bot.makeLog?.("error", [
        "QQBot 主人 openid 绑定失败",
        appid,
        targetOpenid,
        uin,
        err,
      ], data.self_id)
      await data.reply("OPENID 绑定失败，请稍后重试。")
    }
    return
  }

  // --- master 代绑定：普通命令校验目标头像，强制命令跳过校验 ---
  const masterBindMatch = commandText.match(/^#QQ(强制)?绑定\s*(\d{5,12})\s*$/)
  if (masterBindMatch && (masterBindMatch[1] || mentionTargets.length > 0)) {
    if (data.message_type !== "group") {
      await data.reply("代绑定命令仅支持在群聊中使用。")
      return
    }

    if (!isMaster(data)) {
      Bot.makeLog?.("debug", [
        `QQBot 非master代绑定忽略: user_id=${data.user_id} self_id=${data.self_id}`,
      ], data.self_id)
      return
    }

    if (mentionTargets.length !== 1) {
      await data.reply("请只@一名用户，例如：#QQ绑定@某人 123456")
      return
    }

    const force = !!masterBindMatch[1]
    const uin = masterBindMatch[2]
    try {
      await handleMasterBind(data, appid, mentionTargets[0], uin, force)
    } catch (err) {
      Bot.makeLog?.("error", [
        "QQBot 主人代绑定失败",
        appid,
        mentionTargets[0].openid,
        uin,
        err,
      ], data.self_id)
      await data.reply("代绑定失败，请稍后重试。")
    }
    return
  }

  // --- #QQ绑定<QQ号>：直接校验绑定 ---
  const match = text.match(/^(?:#QQ绑定)\s*(\d{5,12})\s*$/)
  if (match) {
    const uin = match[1]
    await data.reply("正在校验...")
    try {
      const ok = await verifyAvatar(appid, rawOpenid, uin)
      if (!ok) {
        await data.reply("绑定失败 和 真实QQ不符合")
        return
      }
      const saved = await saveMapping(appid, rawOpenid, uin)
      if (!saved) {
        await data.reply("绑定失败：映射保存失败，请检查 Redis。")
        return
      }
      await data.reply(`绑定成功：${uin}`)
    } catch (err) {
      Bot.makeLog?.("error", ["QQBot 绑定校验失败", appid, rawOpenid, uin, err], data.self_id)
      await data.reply("绑定失败 请稍后重试。")
    }
    return
  }

  // --- #QQ绑定：显示帮助 ---
  if (text === "#QQ绑定") {
    await data.reply([
      "请发送 #QQ绑定+你的QQ号 进行绑定",
      segment.button([
        { text: "输入QQ号绑定", input: "#QQ绑定 ", send: false },
      ]),
    ])
    return
  }

  // --- #QQ解绑 ---
  if (text === "#QQ解绑") {
    // TODO: 解绑逻辑
    await data.reply("解绑功能开发中")
  }
}

// 监听 QQBot 好友消息 + 群消息（client.js → Bot.em 事件）
async function onBindMessage (data) {
  try {
    await handleBindMessage(data)
  } catch (err) {
    Bot.makeLog?.("error", ["QQBot 绑定消息处理失败", err], data.self_id)
  }
}

Bot.on("message.private.friend", onBindMessage)
Bot.on("message.group.normal", onBindMessage)
