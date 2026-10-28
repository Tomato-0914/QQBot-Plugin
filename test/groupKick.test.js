import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/groupKick.test.js
// 群移出成员：开放平台 POST /v2/groups/{group_openid}/batch_remove_members
const requests = []
const { GroupService } = (await import("../lib/modules/qq-official-bot/lib/services/group.js")).default
  ?? await import("../lib/modules/qq-official-bot/lib/services/group.js")

await test("GroupService 以成员 OpenID 列表调用批量移出接口", async () => {
  const service = new GroupService({
    post: async (url, body) => {
      requests.push({ url, body })
      return { data: { remove_members_result: "success", add_to_member_blacklist_fail_openids: [] } }
    },
  })
  const result = await service.batchRemoveMembers("GROUP_OPENID", ["MEMBER_OPENID"], true)
  assert.deepEqual(requests.at(-1), {
    url: "/v2/groups/GROUP_OPENID/batch_remove_members",
    body: { member_openids: ["MEMBER_OPENID"], add_to_member_blacklist: true },
  })
  assert.equal(result.remove_members_result, "success")
})

// 适配器：只加载 index.js，所有持久化、配置与 SDK 连接都替换为桩
global.logger = new Proxy({}, { get: () => (...args) => args[0] })
global.Bot = Object.assign(Object.create(null), {
  adapter: [],
  getMap: async () => new Map(),
  makeLog () {},
})
mock.module(new URL("../lib/config.js", import.meta.url).href, { namedExports: { config: { bot: {} } } })
mock.module(new URL("../lib/converter.js", import.meta.url).href, { namedExports: { Converter: class {} } })
mock.module(new URL("../lib/client.js", import.meta.url).href, { namedExports: { connectBot: async () => true } })
mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: {
    isQQUin: () => false,
    loadMappingsFromFile: async () => {},
    translateToOpenid: async (_bot, userId) => `openid-${userId}`,
  },
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: {
    loadMappingsFromFile: async () => {},
    translateGroupToOpenid: async (_bot, groupId) => `group-openid-${groupId}`,
  },
})
mock.module(new URL("../lib/messageSender.js", import.meta.url).href, { namedExports: { installMessageSender () {} } })
mock.module(new URL("../lib/messageStore.js", import.meta.url).href, { namedExports: { getRecordByMsgId: async () => undefined } })
for (const app of ["qrlogin", "wildSilence", "autoGroupBind", "groupBind", "bind"])
  mock.module(new URL(`../app/${app}.js`, import.meta.url).href, {
    namedExports: { QRLoginPlugin: class {}, WildSilencePlugin: class {}, AutoGroupBindPlugin: class {} },
  })

await import("../index.js")
const adapter = Bot.adapter.at(-1)
const sdkCalls = []
let removeResult = { remove_members_result: "success", add_to_member_blacklist_fail_openids: [] }
let removeError = null
Bot.bot1 = {
  fl: new Map(),
  gl: new Map(),
  gml: new Map(),
  info: { appid: "appid" },
  sdk: {
    removeGroupMembers: async (...args) => {
      sdkCalls.push(args)
      if (removeError) throw removeError
      return removeResult
    },
  },
}

await test("pickGroup().kickMember 把群号和成员转换为 OpenID 后移出", async () => {
  assert.equal(await adapter.pickGroup("bot1", "123").kickMember("456"), true)
  assert.deepEqual(sdkCalls.at(-1), ["group-openid-123", ["openid-456"], false])
})

await test("reject_add 为 true 时同时加入群黑名单", async () => {
  await adapter.pickGroup("bot1", "123").kickMember("456", true)
  assert.equal(sdkCalls.at(-1)[2], true)
})

await test("成员对象 kick(message, block) 与 icqq 约定一致", async () => {
  await adapter.pickMember("bot1", "123", "789").kick("bye", true)
  assert.deepEqual(sdkCalls.at(-1), ["group-openid-123", ["openid-789"], true])
})

await test("开放平台未返回 success 时报错", async () => {
  removeResult = { remove_members_result: "failed" }
  await assert.rejects(adapter.pickGroup("bot1", "123").kickMember("456"), /移出群成员失败：failed/)
  removeResult = { remove_members_result: "success" }
})

await test("未开通内邀接口（11253）时给出明确提示", async () => {
  removeError = Object.assign(new Error('Request failed with code(11253): no permission'), { code: 11253 })
  await assert.rejects(adapter.pickGroup("bot1", "123").kickMember("456"), err => {
    assert.match(err.message, /未开通踢人接口/)
    assert.equal(err.code, 11253)
    return true
  })
  removeError = new Error("network down")
  await assert.rejects(adapter.pickGroup("bot1", "123").kickMember("456"), /network down/)
  removeError = null
})

await test("群信息缓存过期后重新查询机器人群内身份，is_admin 随之更新", async () => {
  let role = "admin"
  let queries = 0
  Bot.bot2 = {
    gl: new Map([["123", { group_id: "123", group_name: "旧群名", member_role: "member" }]]),
    sdk: {
      getGroupInfo: async () => ({ group_openid: "group-openid-123", group_name: "测试群", group_member_num: 5 }),
      getGroupBotState: async () => {
        queries++
        return { member_role: role }
      },
    },
  }
  const data = { bot: Bot.bot2, group_id: "123", _raw_group_id: "group-openid-123" }
  // 旧缓存没有查询时间：视为过期，重新查询（机器人已被设为管理员）
  await adapter.getGroupInfo(data, false, true)
  assert.equal(queries, 1)
  assert.equal(adapter.pickGroup("bot2", "123").is_admin, true)

  // 有效期内直接用缓存
  role = "member"
  await adapter.getGroupInfo(data, false, true)
  assert.equal(queries, 1)

  // 超过有效期重新查询（取消管理员）
  Bot.bot2.gl.get("123").info_time = Date.now() - 11 * 60 * 1000
  await adapter.getGroupInfo(data, false, true)
  assert.equal(queries, 2)
  assert.equal(adapter.pickGroup("bot2", "123").is_admin, false)
})
