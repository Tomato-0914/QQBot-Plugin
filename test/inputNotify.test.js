import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

// 私聊“正在输入”：POST /v2/users/{openid}/messages，msg_type 6 + input_notify
const { MessageService } = await import("../lib/modules/qq-official-bot/lib/services/message.js")

await test("MessageService 以 msg_type 6 发送正在输入状态", async () => {
  const calls = []
  const service = new MessageService({
    post: async (url, body) => {
      calls.push({ url, body })
      return { data: { ext_info: { ref_idx: "" } } }
    },
  }, "appid")
  await service.sendPrivateInputNotify("USER_OPENID", 30, "MSG_ID")
  assert.deepEqual(calls.at(-1), {
    url: "/v2/users/USER_OPENID/messages",
    body: { msg_type: 6, input_notify: { input_type: 1, input_second: 30 }, msg_id: "MSG_ID" },
  })
  await service.sendPrivateInputNotify("USER_OPENID", 10)
  assert.equal("msg_id" in calls.at(-1).body, false)
})

const notifies = []
let notifyError
const adapter = {
  config: { messageRetentionDays: 0 },
  sendFriendMsg: async () => {},
  setFriendMap: async () => {},
}
global.Bot = {
  10000: {
    uin: "10000",
    info: { id: "10000", appid: "appid" },
    adapter,
    sdk: {
      sendPrivateInputNotify: async (...args) => {
        notifies.push(args)
        if (notifyError) throw notifyError
      },
    },
  },
  em: () => {},
  makeLog: () => {},
}
const { setMessageStoreRoot } = await import("../lib/messageStore.js")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-input-notify-"))
setMessageStoreRoot(root)
const { makeMessage } = await import("../lib/messageBuilder.js")

const friendMessage = id => ({
  id,
  post_type: "message",
  message_type: "private",
  sub_type: "friend",
  raw_message: "你好",
  message: [{ type: "text", data: { text: "你好" } }],
  sender: { user_id: "FRIEND_OPENID" },
  timestamp: 1,
})

await test("收到私聊消息时显示正在输入，可以关闭", async () => {
  await makeMessage(adapter, "10000", friendMessage("m1"))
  assert.deepEqual(notifies.at(-1), ["FRIEND_OPENID", 30, "m1"])

  adapter.config.inputNotify = false
  await makeMessage(adapter, "10000", friendMessage("m2"))
  assert.equal(notifies.length, 1)
  delete adapter.config.inputNotify
})

await test("发送正在输入失败不影响消息处理", async () => {
  notifyError = new Error("no permission")
  let emitted
  Bot.em = (_name, data) => { emitted = data }
  await makeMessage(adapter, "10000", friendMessage("m3"))
  assert.equal(emitted?.message_id, "m3")
  notifyError = undefined
  await emitted.sendInputNotify(5)
  assert.deepEqual(notifies.at(-1), ["FRIEND_OPENID", 5, "m3"])
})

await fs.rm(root, { recursive: true, force: true })
