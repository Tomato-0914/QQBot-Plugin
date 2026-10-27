import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 先从包入口初始化 SDK，避免直接加载事件子模块触发其既有循环依赖。
const { Bot, EventParserMap, QQEvent, segment } = await import("qq-official-bot")
const { MessageService } = await import("../lib/modules/qq-official-bot/lib/services/message.js")
const { GroupService } = await import("../lib/modules/qq-official-bot/lib/services/group.js")
const { ChunkedUploader } = await import("../lib/modules/qq-official-bot/lib/message/chunked-upload.js")

function recorder (status = 204, data = {}) {
  const calls = []
  const request = {}
  for (const method of ["get", "post", "put", "patch", "delete"])
    request[method] = async (url, ...args) => {
      calls.push({ method, url, args: structuredClone(args) })
      return { status, data }
    }
  return { calls, request }
}

// 频道管理接口的方法、路径与参数名按官方文档发送。
{
  const { calls, request } = recorder()
  const bot = { request }
  await Bot.prototype.muteGuild.call(bot, "guild", 60, 0)
  await Bot.prototype.muteGuildMembers.call(bot, "guild", ["user"], 60, 0)
  await Bot.prototype.muteGuildMember.call(bot, "guild", "user", 60, 0)
  await Bot.prototype.pinChannelMessage.call(bot, "channel", "message")
  await Bot.prototype.publishThread.call(bot, "channel", "title", "content")
  await Bot.prototype.deleteGuildRole.call(bot, "guild", "role")
  await Bot.prototype.addGuildMemberRoles.call(bot, "guild", "channel", "user", "5")
  await Bot.prototype.removeGuildMemberRoles.call(bot, "guild", "channel", "user", "5")
  await Bot.prototype.kickGuildMember.call(bot, "guild", "user", 7, true)
  assert.deepEqual(calls.map(({ method, url }) => `${method.toUpperCase()} ${url}`), [
    "PATCH /guilds/guild/mute",
    "PATCH /guilds/guild/mute",
    "PATCH /guilds/guild/members/user/mute",
    "PUT /channels/channel/pins/message",
    "PUT /channels/channel/threads",
    "DELETE /guilds/guild/roles/role",
    "PUT /guilds/guild/members/user/roles/5",
    "DELETE /guilds/guild/members/user/roles/5",
    "DELETE /guilds/guild/members/user",
  ])
  assert.deepEqual(calls[6].args[0], { channel: { id: "channel" } })
  assert.deepEqual(calls[7].args[0], { data: { channel: { id: "channel" } } })
  assert.deepEqual(calls[8].args[0], { data: { add_blacklist: true, delete_history_msg_days: 7 } })
}

// 群成员列表按 next_cursor 翻页，空游标或重复游标时停止。
{
  const pages = {
    "": { members: [{ member_openid: "a" }], next_cursor: "c1" },
    c1: { members: [{ member_openid: "b" }], next_cursor: "c2" },
    c2: { members: [{ member_openid: "c" }], next_cursor: "c1" },
  }
  const urls = []
  const groupService = new GroupService({
    get: async (url, config) => {
      urls.push([url, config?.params?.cursor])
      return { data: url.endsWith("/members/a") ? { member_openid: "a" } : pages[config?.params?.cursor || ""] }
    },
  })
  const bot = { groupService }
  const members = await Bot.prototype.getGroupMemberList.call(bot, "group")
  assert.deepEqual(members.map(member => member.member_openid), ["a", "b", "c"])
  assert.deepEqual(urls, [
    ["/v2/groups/group/members", undefined],
    ["/v2/groups/group/members", "c1"],
    ["/v2/groups/group/members", "c2"],
  ])
  assert.deepEqual(await Bot.prototype.getGroupMemberInfo.call(bot, "group", "a"), { member_openid: "a" })
}

// 通知事件的 timestamp 为 Unix 秒；频道按钮点击从 data.resolved.user_id 取操作人。
{
  const emitted = []
  const bot = {
    emit: (...args) => emitted.push(args),
    logger: { info () {} },
  }
  const parseNotice = event => EventParserMap.get(event).call(bot, event, { timestamp: 1784570617 })
  assert.equal(parseNotice(QQEvent.FRIEND_ADD).time, 1784570617)
  assert.equal(parseNotice(QQEvent.C2C_MSG_RECEIVE).time, 1784570617)
  assert.equal(parseNotice(QQEvent.GROUP_ADD_ROBOT).time, 1784570617)
  assert.equal(parseNotice(QQEvent.GROUP_MSG_REJECT).time, 1784570617)

  const action = EventParserMap.get(QQEvent.INTERACTION_CREATE).call(bot, QQEvent.INTERACTION_CREATE, {
    id: "interaction",
    scene: "guild",
    guild_id: "guild",
    channel_id: "channel",
    data: { type: 11, resolved: { button_id: "button", user_id: "user" } },
  })
  assert.equal(action.operator_id, "user")
  assert.equal(action.notice_type, "guild")
}

// @ 使用官方新格式，不再拼接即将弃用的 <@userid> 和 @everyone。
{
  const payloads = []
  const service = new MessageService({
    post: async (_url, payload) => {
      payloads.push(structuredClone(payload))
      return { data: { id: "sent" }, status: 200 }
    },
  }, "appid")
  await service.sendGuildMessage("channel", [segment.at("user"), "hi", segment.at("all")])
  assert.equal(payloads[0].content, '<qqbot-at-user id="user" />hi<qqbot-at-everyone />')
}

// 分片上传同时兼容从 0 和从 1 开始的分片序号，并读取 upload_config 中的并发配置。
{
  const dir = await mkdtemp(join(tmpdir(), "qqbot-chunk-"))
  const file = join(dir, "video.mp4")
  await writeFile(file, Buffer.alloc(2500, 1))
  const originalFetch = global.fetch
  try {
    for (const [base, prepared] of [
      [0, { upload_config: { concurrency: 3, retry_timeout: 300 } }],
      [1, { concurrency: 1 }],
    ]) {
      const puts = []
      global.fetch = async (url, options) => {
        puts.push([url, (await options.body.arrayBuffer()).byteLength])
        return { ok: true }
      }
      const finished = []
      const uploader = new ChunkedUploader({
        post: async (url, body) => {
          if (url.endsWith("/upload_prepare"))
            return {
              data: {
                upload_id: "upload",
                block_size: "1000",
                parts: [0, 1, 2].map(i => ({ index: i + base, presigned_url: `https://cos.invalid/${i}` })),
                ...prepared,
              },
            }
          if (url.endsWith("/upload_part_finish")) {
            finished.push([body.part_index, body.block_size])
            return { data: {} }
          }
          return { data: { file_info: "file-info" } }
        },
      })
      const result = await uploader.upload("/v2/groups/group", file, 2)
      assert.equal(result.file_info, "file-info")
      // 并发上传时完成顺序不固定，按分片排序后比较
      assert.deepEqual(puts.sort().map(([, size]) => size), [1000, 1000, 500])
      assert.deepEqual(finished.sort(([a], [b]) => a - b), [[base, 1000], [base + 1, 1000], [base + 2, 500]])
    }
  } finally {
    global.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
}

// 分片上传网络失败后，只有 5MB 以内的文件改用 base64 上传。
{
  const dir = await mkdtemp(join(tmpdir(), "qqbot-base64-"))
  const originalFetch = global.fetch
  global.fetch = async () => {
    throw new TypeError("fetch failed")
  }
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    for (const [size, expectBase64] of [[5 * 1024 * 1024, true], [5 * 1024 * 1024 + 1, false]]) {
      const file = join(dir, `${size}.mp4`)
      await writeFile(file, Buffer.alloc(size))
      const urls = []
      const service = new MessageService({
        post: async (url, body) => {
          urls.push(url)
          if (url.endsWith("/upload_prepare"))
            return {
              data: {
                upload_id: "upload",
                block_size: String(size),
                parts: [{ index: 1, presigned_url: "https://cos.invalid/0" }],
              },
            }
          assert.equal(typeof body.file_data, "string")
          return { data: { file_info: "file-info" } }
        },
      }, "appid")
      const upload = service.uploadFile("/v2/groups/group", {
        filePayload: { local_path: file, file_type: 2 },
      }, {})
      if (expectBase64) {
        assert.equal((await upload).file_info, "file-info")
        assert.deepEqual(urls, ["/v2/groups/group/upload_prepare", "/v2/groups/group/files"])
      } else {
        await assert.rejects(upload, /fetch failed/)
        assert.deepEqual(urls, ["/v2/groups/group/upload_prepare"])
      }
    }
  } finally {
    global.fetch = originalFetch
    console.warn = originalWarn
    await rm(dir, { recursive: true, force: true })
  }
}

console.log("sdk api docs tests passed")
