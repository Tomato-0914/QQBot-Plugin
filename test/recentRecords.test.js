import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { listRecentRecords, markMsgRecordRecalled, saveMsgRecord, setMessageStoreRoot } from "../lib/messageStore.js"

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
