import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/groupJoinRequest.test.js
// 入群申请：GROUP_JOIN_REQUEST 事件、申请列表与审批接口
// 先从包入口初始化 SDK，避免直接加载事件子模块触发其既有循环依赖。
const { Bot: SdkBot, EventParserMap, QQEvent } = await import("qq-official-bot")
const { GroupService } = await import("../lib/modules/qq-official-bot/lib/services/group.js")

const payload = {
  group_openid: "GROUP_OPENID",
  member_openid: "MEMBER_OPENID",
  username: "路人甲",
  join_request_id: "REQ_1",
  apply_source: "self_apply",
  invited_by: "",
  apply_at: "2026-08-11T00:06:29+08:00",
  verify_info: {
    method: "admin_review_qa",
    verify_message: "",
    review_qa_list: [{ question: "从哪知道的群", answer: "朋友推荐" }],
  },
}

await test("GROUP_JOIN_REQUEST 解析为 notice.group.request", () => {
  assert.equal(QQEvent.GROUP_JOIN_REQUEST, "notice.group.request")
  const sdk = { logger: { info () {} } }
  const event = EventParserMap.get(QQEvent.GROUP_JOIN_REQUEST).call(sdk, "notice.group.request", { event_id: "EV", ...payload })
  assert.equal(event.sub_type, "request")
  assert.equal(event.group_id, "GROUP_OPENID")
  assert.equal(event.user_id, "MEMBER_OPENID")
  assert.equal(event.user_name, "路人甲")
  assert.equal(event.join_request_id, "REQ_1")
  assert.equal(event.invited_by, undefined)
  assert.equal(event.time, Math.floor(new Date(payload.apply_at).getTime() / 1000))
})

await test("申请列表翻页，审批按 approve / decline 调用接口", async () => {
  const requests = []
  const pages = { undefined: { list: [{ join_request_id: "A" }], next_cursor: "c1" }, c1: { list: [{ join_request_id: "B" }], next_cursor: "c1" } }
  const service = new GroupService({
    get: async (url, options) => {
      requests.push({ url, params: options.params })
      return { data: pages[options.params.cursor] }
    },
    post: async (url, body) => {
      requests.push({ url, body })
      return { status: 200, data: {} }
    },
  })
  const sdk = Object.assign(Object.create(SdkBot.prototype), { groupService: service })

  const list = await sdk.getGroupJoinRequestList("G")
  assert.deepEqual(list.map(item => item.join_request_id), ["A", "B"])
  assert.deepEqual(requests[0], { url: "/v2/groups/G/join_request_list", params: { limit: 50 } })
  assert.deepEqual(requests[1].params, { limit: 50, cursor: "c1" })
  assert.equal(requests.length, 2, "游标重复时停止")

  assert.equal(await sdk.setGroupJoinRequest("G", "M", true, { join_request_id: "A", reject_reason: "x", add_to_blacklist: true }), true)
  assert.deepEqual(requests.at(-1), {
    url: "/v2/groups/G/approval_join_request/M",
    body: { op: "approve", join_request_id: "A", reject_reason: "", add_to_member_blacklist: false },
  })
  await sdk.setGroupJoinRequest("G", "M", false, { join_request_id: "B", reject_reason: "答案不对", add_to_blacklist: true })
  assert.deepEqual(requests.at(-1).body, { op: "decline", join_request_id: "B", reject_reason: "答案不对", add_to_member_blacklist: true })
})

await test("群黑名单翻页，加入、移出分别用 add / del", async () => {
  const requests = []
  const pages = { undefined: { users: [{ member_openid: "A" }], next_cursor: "c1" }, c1: { users: [{ member_openid: "B" }] } }
  const service = new GroupService({
    get: async (url, options) => {
      requests.push({ url, params: options.params })
      return { data: pages[options.params.cursor] }
    },
    post: async (url, body) => {
      requests.push({ url, body })
      return { data: { fail_openids: [] } }
    },
  })
  const sdk = Object.assign(Object.create(SdkBot.prototype), { groupService: service })

  assert.deepEqual((await sdk.getGroupMemberBlacklist("G")).map(user => user.member_openid), ["A", "B"])
  assert.deepEqual(requests[0], { url: "/v2/groups/G/member_blacklist", params: { limit: 100 } })
  await sdk.setGroupMemberBlacklist("G", ["A"], true)
  assert.deepEqual(requests.at(-1), { url: "/v2/groups/G/member_blacklist", body: { op: "add", member_openids: ["A"] } })
  await sdk.setGroupMemberBlacklist("G", ["A"], false)
  assert.equal(requests.at(-1).body.op, "del")
  await assert.rejects(sdk.setGroupMemberBlacklist("G", Array(21).fill("A")), /最多操作 20 个/)
})

// 适配器：client.js 的依赖全部替换为桩
mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: {
    applyUinMapping: async () => {},
    getAppid: () => "appid",
    getMappedUin: async (_appid, openid) => (openid === "MEMBER_OPENID" ? "10001" : undefined),
  },
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, {
  namedExports: { getGroupUin: async () => "123456" },
})
mock.module(new URL("../lib/messageBuilder.js", import.meta.url).href, { namedExports: { makeMessage: async () => {} } })
mock.module(new URL("../lib/messageStore.js", import.meta.url).href, { namedExports: { getRecordByMsgId: async () => undefined } })
mock.module(new URL("../lib/streamMessage.js", import.meta.url).href, { namedExports: { makeStreamReplyPayload: p => p } })

const emitted = []
const sdkCalls = []
const sent = []
global.Bot = Object.assign(Object.create(null), {
  makeLog () {},
  em: (name, data) => emitted.push([name, data]),
})
Bot.bot1 = { sdk: { setGroupJoinRequest: async (...args) => { sdkCalls.push(args); return true } } }
const adapter = { sendGroupMsg: async (...args) => sent.push(args) }
const { joinRequestComment, makeGroupJoinRequest } = await import("../lib/client.js")

await test("验证信息转成文字", () => {
  assert.equal(joinRequestComment(payload.verify_info), "问题：从哪知道的群\n答案：朋友推荐")
  assert.equal(joinRequestComment({ verify_message: "我是新人" }), "我是新人")
  assert.equal(joinRequestComment(undefined), "")
})

await test("入群申请转成 request.group.add，e.approve 调用审批接口", async () => {
  const sdk = { logger: { info () {} } }
  const event = EventParserMap.get(QQEvent.GROUP_JOIN_REQUEST).call(sdk, "notice.group.request", { event_id: "EV", ...payload })
  const data = await makeGroupJoinRequest(adapter, "bot1", event)

  assert.equal(emitted.at(-1)[0], "request.group.add")
  assert.equal(data.post_type, "request")
  assert.equal(data.group_id, "123456")
  assert.equal(data.user_id, "10001")
  assert.equal(data._raw_user_id, "MEMBER_OPENID")
  assert.equal(data.flag, "REQ_1")
  assert.equal(data.comment, "问题：从哪知道的群\n答案：朋友推荐")

  await data.approve(false, "答案不对", true)
  assert.deepEqual(sdkCalls.at(-1), ["GROUP_OPENID", "MEMBER_OPENID", false, {
    join_request_id: "REQ_1", reject_reason: "答案不对", add_to_blacklist: true,
  }])
  await data.approve()
  assert.equal(sdkCalls.at(-1)[2], true)

  await data.reply("欢迎")
  assert.equal(sent.at(-1)[0].group_id, "GROUP_OPENID")
})

await test("被邀请的申请为 request.group.invite", async () => {
  const sdk = { logger: { info () {} } }
  const event = EventParserMap.get(QQEvent.GROUP_JOIN_REQUEST).call(sdk, "notice.group.request", { ...payload, invited_by: "INVITER" })
  await makeGroupJoinRequest(adapter, "bot1", event)
  assert.equal(emitted.at(-1)[0], "request.group.invite")
})
