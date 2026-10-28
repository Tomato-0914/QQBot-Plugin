import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/autoUserBind.test.js
// 自动 QQ 绑定：官方机器人的 openid 和野生号的 QQ 号按「同群 + 同文字 + 时间相近」对应
global.Bot = { uin: ["official", "wild"], on () {}, makeLog () {} }

const { createAutoUserBind, textKey, WINDOW } = await import("../lib/autoUserBind.js")

const text = s => [{ type: "text", text: s }]

/** 用假时钟驱动：onOfficial 在 WINDOW 后匹配 */
function setup({ avatar = { ok: true, custom: true }, mappedUin = {}, mappedOpenid = {} } = {}) {
  let now = 0
  const timers = []
  const saved = []
  const checks = []
  const logs = []
  const binder = createAutoUserBind({
    now: () => now,
    schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
    check: async (...args) => {
      checks.push(args)
      return typeof avatar === "function" ? avatar(...args) : avatar
    },
    getUin: async (appid, openid) => mappedUin[openid] || false,
    getOpenid: async (appid, uin) => mappedOpenid[uin] || false,
    save: async (...args) => {
      saved.push(args)
      mappedUin[args[1]] = args[2]
      return true
    },
    log: (level, msg) => logs.push([level, msg.join(" ")]),
  })
  return {
    binder,
    saved,
    checks,
    logs,
    tick (ms) {
      now += ms
    },
    /** 时间推进 ms，执行到期的匹配 */
    async run (ms = WINDOW) {
      now += ms
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (t.at <= now) t.fn()
        else timers.push(t)
      }
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

const official = (openid, key, group = "123456", appid = "app") => ({ appid, group, openid, key })
const wild = (uin, key, group = "123456") => ({ group, uin, key })

test("textKey 只取文字并去掉空白，少于 2 个字不参与", () => {
  assert.equal(textKey([{ type: "at", qq: "1" }, { type: "text", text: " 今天 吃什么 " }]), "今天吃什么")
  assert.equal(textKey(text("1")), "")
  assert.equal(textKey([{ type: "image" }]), "")
  assert.equal(textKey(text("😀😀")), "😀😀")
})

test("同群同文字、两边各只有一个发送者：头像校验通过后绑定", async () => {
  const t = setup()
  const done = t.binder.onOfficial(official("OPENID_A", "今天吃什么"))
  t.binder.onWild(wild("85273416", "今天吃什么"))
  await t.run()
  assert.equal(await done, true)
  assert.deepEqual(t.saved, [["app", "OPENID_A", "85273416"]])
  assert.match(t.logs.at(-1)[1], /自动绑定成功：OPENID_A → 85273416/)
})

test("野生号的消息晚到几秒、或早于官方机器人到达，都能对上", async () => {
  const t = setup()
  t.binder.onWild(wild("10001", "早到的消息"))
  t.tick(3000)
  const a = t.binder.onOfficial(official("OPENID_A", "早到的消息"))
  const b = t.binder.onOfficial(official("OPENID_B", "晚到的消息"))
  t.tick(5000)
  t.binder.onWild(wild("10002", "晚到的消息"))
  await t.run(WINDOW)
  assert.equal(await a, true)
  assert.equal(await b, true)
  assert.deepEqual(t.saved.map(s => s[2]).sort(), ["10001", "10002"])
})

test("多人同时发相同内容时放弃匹配", async () => {
  const t = setup()
  const a = t.binder.onOfficial(official("OPENID_A", "哈哈哈"))
  const b = t.binder.onOfficial(official("OPENID_B", "哈哈哈"))
  t.binder.onWild(wild("10001", "哈哈哈"))
  t.binder.onWild(wild("10002", "哈哈哈"))
  await t.run()
  assert.equal(await a, false)
  assert.equal(await b, false)

  // 野生号这边两个 QQ 号发了同样的内容，官方机器人只收到一个未绑定的
  const c = t.binder.onOfficial(official("OPENID_C", "收到收到"))
  t.binder.onWild(wild("10003", "收到收到"))
  t.binder.onWild(wild("10004", "收到收到"))
  await t.run()
  assert.equal(await c, false)
  assert.deepEqual(t.saved, [])
  assert.deepEqual(t.checks, [])
})

test("不同群、超出时间窗口的消息不匹配", async () => {
  const t = setup()
  const a = t.binder.onOfficial(official("OPENID_A", "在吗在吗", "111"))
  t.binder.onWild(wild("10001", "在吗在吗", "222"))
  await t.run()
  assert.equal(await a, false)

  t.binder.onWild(wild("10002", "好久不见"))
  t.tick(WINDOW + 1000)
  const b = t.binder.onOfficial(official("OPENID_B", "好久不见"))
  await t.run()
  assert.equal(await b, false)
  assert.deepEqual(t.saved, [])
})

test("默认头像需要两段不同的文字都对上才绑定", async () => {
  const t = setup({ avatar: { ok: true, custom: false } })
  for (const key of ["第一句话", "第一句话"]) {
    const done = t.binder.onOfficial(official("OPENID_A", key))
    t.binder.onWild(wild("10001", key))
    await t.run()
    assert.equal(await done, false)
  }
  const done = t.binder.onOfficial(official("OPENID_A", "第二句话"))
  t.binder.onWild(wild("10001", "第二句话"))
  await t.run()
  assert.equal(await done, true)
  assert.deepEqual(t.saved, [["app", "OPENID_A", "10001"]])
  assert.equal(t.checks.length, 1, "头像校验结果在有效期内复用")
})

test("头像校验不通过不保存，一小时后才重新校验", async () => {
  const t = setup({ avatar: { ok: false, custom: true } })
  const say = async key => {
    const done = t.binder.onOfficial(official("OPENID_A", key))
    t.binder.onWild(wild("10001", key))
    await t.run()
    return done
  }
  assert.equal(await say("第一句话"), false)
  assert.equal(await say("第二句话"), false)
  assert.equal(t.checks.length, 1)
  t.tick(60 * 60 * 1000)
  await say("第三句话")
  assert.equal(t.checks.length, 2)
  assert.deepEqual(t.saved, [])
})

test("已绑定的 openid 跳过；QQ 号已绑定给别的 openid 视为冲突", async () => {
  const t = setup({ mappedUin: { OPENID_A: "10001" }, mappedOpenid: { 10002: "OPENID_OTHER" } })
  const a = t.binder.onOfficial(official("OPENID_A", "第一句话"))
  t.binder.onWild(wild("10001", "第一句话"))
  const b = t.binder.onOfficial(official("OPENID_B", "第二句话"))
  t.binder.onWild(wild("10002", "第二句话"))
  await t.run()
  assert.equal(await a, false)
  assert.equal(await b, false)
  assert.deepEqual(t.saved, [])
  assert.deepEqual(t.checks, [])
  assert.match(t.logs.at(-1)[1], /冲突.*OPENID_B ↔ 10002/)
})

test("同一个 openid 对上过不同的 QQ 号后不再自动绑定", async () => {
  const t = setup({ avatar: { ok: true, custom: false } })
  const say = async (uin, key) => {
    const done = t.binder.onOfficial(official("OPENID_A", key))
    t.binder.onWild(wild(uin, key))
    await t.run()
    return done
  }
  assert.equal(await say("10001", "第一句话"), false)
  assert.equal(await say("10002", "第二句话"), false)
  assert.equal(await say("10001", "第三句话"), false)
  assert.equal(await say("10001", "第四句话"), false)
  assert.deepEqual(t.saved, [])
})

test("同一个 QQ 号对上过不同的 openid 后两边都不再自动绑定", async () => {
  const t = setup({ avatar: { ok: true, custom: false } })
  const say = async (openid, key) => {
    const done = t.binder.onOfficial(official(openid, key))
    t.binder.onWild(wild("10001", key))
    await t.run()
    return done
  }
  assert.equal(await say("OPENID_A", "第一句话"), false)
  assert.equal(await say("OPENID_B", "第二句话"), false)
  assert.equal(await say("OPENID_A", "第三句话"), false)
  assert.equal(await say("OPENID_B", "第四句话"), false)
  assert.deepEqual(t.saved, [])
})

test("不同官方机器人（appid）的 openid 分开计算，互不干扰", async () => {
  const t = setup()
  const a = t.binder.onOfficial(official("OPENID_A1", "大家好呀", "123456", "app1"))
  const b = t.binder.onOfficial(official("OPENID_A2", "大家好呀", "123456", "app2"))
  t.binder.onWild(wild("10001", "大家好呀"))
  await t.run()
  assert.equal(await a, true)
  assert.equal(await b, true)
  assert.deepEqual(t.saved.map(s => s.join(":")).sort(), ["app1:OPENID_A1:10001", "app2:OPENID_A2:10001"])
})

test("事件接入：只收已做群绑定的群、未绑定的官方用户和野生号的真人消息", async () => {
  const calls = []
  const listeners = []
  global.Bot = {
    uin: ["official", "wild"],
    on: (name, fn) => listeners.push([name, fn]),
    makeLog () {},
  }
  const cfg = {}
  mock.module(new URL("../lib/config.js", import.meta.url).href, { exports: { config: cfg } })
  mock.module(new URL("../lib/wildSilence.js", import.meta.url).href, {
    exports: { isWild: id => id === "wild" },
  })
  delete globalThis.__autoUserBind
  globalThis.__autoUserBind = {
    hooked: false,
    binder: {
      onOfficial: arg => calls.push(["official", arg]),
      onWild: arg => calls.push(["wild", arg]),
    },
  }
  await import("../app/autoUserBind.js")
  assert.deepEqual(listeners.map(l => l[0]), ["message.group.normal"])
  const emit = data => listeners[0][1](data)
  const qqbot = { adapter: { id: "QQBot" }, info: { appid: "app" } }

  emit({ bot: qqbot, self_id: "official", group_id: "123456", user_id: "OPENID_A", message: text("你好你好") })
  emit({ bot: qqbot, self_id: "official", group_id: "123456", user_id: "85273416", message: text("已绑定的") })
  emit({ bot: qqbot, self_id: "official", group_id: "GROUP_OPENID", user_id: "OPENID_B", message: text("未绑群的") })
  emit({ bot: { adapter: { id: "QQ" } }, self_id: "wild", group_id: 123456, user_id: 10001, message: text("你好你好") })
  emit({ bot: { adapter: { id: "QQ" } }, self_id: "wild", group_id: 123456, user_id: "official", message: text("机器人的") })
  emit({ bot: { adapter: { id: "QQ" } }, self_id: "wild", group_id: 123456, user_id: 10002, message: text("1") })

  assert.deepEqual(calls, [
    ["official", { appid: "app", group: "123456", openid: "OPENID_A", key: "你好你好" }],
    ["wild", { group: "123456", uin: "10001", key: "你好你好" }],
  ])

  cfg.autoBindUser = false
  emit({ bot: qqbot, self_id: "official", group_id: "123456", user_id: "OPENID_C", message: text("关闭后的") })
  assert.equal(calls.length, 2)
})
