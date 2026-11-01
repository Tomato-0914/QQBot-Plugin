import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  clearRecentRecords,
  getChatHistory,
  getRecordByMsgId,
  getRecordByMsgIdx,
  listRecentRecords,
  markMsgRecordRecalled,
  saveMsgRecord,
  setMessageStoreRoot,
} from "../lib/messageStore.js"

// Run with: node --test test/recentRecords.test.js
// 官方接口拉不到历史消息：撤回机器人最近发的消息时，从本地 JSONL 记录里取 message_id

test("按时间从早到晚返回最近的记录，可只取机器人自己发的，已撤回的跳过", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-recent-"))
  setMessageStoreRoot(root)
  try {
    const base = Date.parse("2026-10-30T09:00:00+08:00")
    const save = (direction, id, offset, text, group = "GROUP_A") => saveMsgRecord("bot", {
      direction,
      scene: "group",
      self_id: "bot",
      time: base + offset * 1000,
      message_id: id,
      group_openid: group,
      sender: direction === "outgoing" ? { bot: true } : { user_openid: "user" },
      message: [{ type: "text", text }],
      raw_message: text,
    })
    await save("incoming", "in-1", 0, "群友：签到")
    await save("outgoing", "out-1", 1, "机器人：签到成功")
    await save("outgoing", "out-2", 2, "机器人：哈啊——")
    await save("incoming", "in-2", 3, "群友：撤回你刚才那条")
    await save("outgoing", "out-3", 4, "机器人：好的")
    await save("outgoing", "other-group", 5, "别的群", "GROUP_B")
    await markMsgRecordRecalled("bot", "out-3", { groupOpenId: "GROUP_A" })

    const outgoing = await listRecentRecords("bot", { groupOpenId: "GROUP_A" }, { direction: "outgoing", limit: 5 })
    assert.deepEqual(outgoing.map(r => r.message_id), ["out-1", "out-2"])
    assert.equal(outgoing[1].raw_message, "机器人：哈啊——")

    const latest = await listRecentRecords("bot", { groupOpenId: "GROUP_A" }, { direction: "outgoing", limit: 1 })
    assert.deepEqual(latest.map(r => r.message_id), ["out-2"])

    const all = await listRecentRecords("bot", { groupOpenId: "GROUP_A" }, { limit: 10 })
    assert.deepEqual(all.map(r => r.message_id), ["in-1", "out-1", "out-2", "in-2"])

    assert.deepEqual(await listRecentRecords("bot", { groupOpenId: "GROUP_EMPTY" }), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("getChatHistory：取 seq 及之前的 cnt 条，seq 在最后；seq 为空时取最新的", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-history-"))
  setMessageStoreRoot(root)
  try {
    const base = Date.parse("2026-10-30T09:00:00+08:00")
    for (let n = 1; n <= 5; n++)
      await saveMsgRecord("bot", {
        direction: "incoming",
        scene: "group",
        self_id: "bot",
        time: base + n * 1000,
        message_id: `m${n}`,
        group_openid: "GROUP_A",
        sender: { user_openid: "user" },
        message: [{ type: "text", text: `第${n}条` }],
        raw_message: `第${n}条`,
      })
    await markMsgRecordRecalled("bot", "m3", { groupOpenId: "GROUP_A" })

    const scope = { groupOpenId: "GROUP_A" }
    assert.deepEqual((await getChatHistory("bot", scope, "m4", 3)).map(m => m.message_id), ["m1", "m2", "m4"])
    assert.deepEqual((await getChatHistory("bot", scope, "m2", 1)).map(m => m.raw_message), ["第2条"])
    assert.deepEqual((await getChatHistory("bot", scope, undefined, 2)).map(m => m.message_id), ["m4", "m5"])
    assert.deepEqual(await getChatHistory("bot", scope, "not-found", 5), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("最近的消息从内存索引查，不读文件；索引外的消息、撤回标记照常生效", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-index-"))
  setMessageStoreRoot(root)
  try {
    const time = Date.now()
    await saveMsgRecord("bot", {
      direction: "incoming", scene: "group", self_id: "bot", time, message_id: "idx-1", msg_idx: "REFIDX_1",
      group_openid: "GROUP_A", sender: { user_openid: "user" }, message: [{ type: "text", text: "你好" }], raw_message: "你好",
    })
    // 文件删掉后仍能从索引查到，说明没有读文件
    await fs.rm(path.join(root, "bot"), { recursive: true, force: true })
    assert.equal((await getRecordByMsgId("bot", "idx-1", { groupOpenId: "GROUP_A" })).raw_message, "你好")
    assert.equal((await getRecordByMsgIdx("bot", "REFIDX_1", { groupOpenId: "GROUP_A" })).message_id, "idx-1")
    assert.equal((await getRecordByMsgId("bot", "idx-1")).message_id, "idx-1")
    // 会话范围不符时不用索引
    assert.equal(await getRecordByMsgId("bot", "idx-1", { groupOpenId: "GROUP_B" }), null)

    // 清空索引后从文件查
    await saveMsgRecord("bot", {
      direction: "outgoing", scene: "group", self_id: "bot", time, message_id: "idx-2",
      group_openid: "GROUP_A", sender: { bot: true }, message: [{ type: "text", text: "在呢" }], raw_message: "在呢",
    })
    clearRecentRecords()
    assert.equal((await getRecordByMsgId("bot", "idx-2", { groupOpenId: "GROUP_A" })).raw_message, "在呢")

    // 撤回后索引和文件都查不到
    await saveMsgRecord("bot", {
      direction: "outgoing", scene: "group", self_id: "bot", time, message_id: "idx-3",
      group_openid: "GROUP_A", sender: { bot: true }, message: [{ type: "text", text: "撤回我" }], raw_message: "撤回我",
    })
    assert.equal(await markMsgRecordRecalled("bot", "idx-3", { groupOpenId: "GROUP_A" }), true)
    assert.equal(await getRecordByMsgId("bot", "idx-3", { groupOpenId: "GROUP_A" }), null)
    clearRecentRecords()
    assert.equal(await getRecordByMsgId("bot", "idx-3", { groupOpenId: "GROUP_A" }), null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
