import assert from "node:assert/strict"

// raw_message 里的官方 @ 标签（<@openid>）原样交给插件时，chatgpt-plugin 的群聊上下文会把机器人的 openid 当成发消息的人
global.Bot = {
  String: value => String(value),
  makeLog () {},
}
global.redis = {
  get: async key => ({
    "map:qqbot:appid:MAPPED-OPENID": "123456789",
  })[key] ?? null,
}

const { readableRaw } = await import("../lib/rawMessage.js")
const { adaptMessageRecord, MESSAGE_RECORD_VERSION } = await import("../lib/messageRecord.js")

const bot = { uin: "3889047076", nickname: "柴郡", info: { appid: "appid" } }

// @机器人自己：mentions 里 is_you 为 true，没有 username 时用机器人昵称
assert.equal(
  await readableRaw("<@BOT-OPENID> 宝宝柴郡", { bot, mentions: [{ id: "BOT-OPENID", bot: true, is_you: true }] }),
  "@柴郡 宝宝柴郡",
)

// 名字优先取 mentions / @ 消息段，其次绑定的 QQ 号，都没有时写“@群友”
assert.equal(
  await readableRaw("<@NAMED-OPENID> <@SEG-OPENID> <@MAPPED-OPENID> <@!UNKNOWN-OPENID> 开会", {
    bot,
    mentions: [{ id: "NAMED-OPENID", username: "小明" }],
    message: [{ type: "at", _raw_user_id: "SEG-OPENID", qq: "SEG-OPENID", username: "小红" }],
  }),
  "@小明 @小红 @123456789 @群友 开会",
)

// Markdown 里的 @ 标签和 @全体成员
assert.equal(
  await readableRaw('<qqbot-at-user id="MAPPED-OPENID" /> 和 <qqbot-at-everyone /> 都来', { bot }),
  "@123456789 和 @全体成员 都来",
)

// 同一个人被 @ 两次只查一次，结果一致
assert.equal(
  await readableRaw("<@MAPPED-OPENID><@MAPPED-OPENID>", { bot }),
  "@123456789@123456789",
)

// 没有 @ 标签时原样返回（包括非字符串）
assert.equal(await readableRaw("普通消息", { bot }), "普通消息")
assert.equal(await readableRaw(undefined, { bot }), undefined)

// 本地消息记录读出来时（群聊上下文、引用的消息）也换成可读文字
const record = await adaptMessageRecord(undefined, bot, {
  version: MESSAGE_RECORD_VERSION,
  direction: "incoming",
  scene: "group",
  self_id: "3889047076",
  message_id: "ROBOT1.0_test",
  raw: {
    message_type: "group",
    group_openid: "GROUP-OPENID",
    author: { id: "MAPPED-OPENID", username: "番茄酱" },
    content: "<@BOT-OPENID> 把这条消息撤回",
    mentions: [{ id: "BOT-OPENID", bot: true, is_you: true }],
    timestamp: "2026-10-30T23:23:19+08:00",
  },
})
assert.equal(record.raw_message, "@柴郡 把这条消息撤回")
assert.equal(record.sender.user_id, "123456789", "发送人仍按绑定换成 QQ 号")

console.log("rawMessage.test.js 通过")
