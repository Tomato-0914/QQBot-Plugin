import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/reconnect.test.js
// 连接失败后自动重试：30 秒起每次翻倍，最长 10 分钟；AppID 或密钥错误时不重试
global.logger = new Proxy({}, { get: () => (...args) => args[0] })
const logs = []
global.Bot = Object.assign(Object.create(null), {
  adapter: [],
  getMap: async () => new Map(),
  makeLog: (...args) => logs.push(args),
  sleep: async () => {},
})

let results = []
const attempts = []
let stops = 0
mock.module(new URL("../lib/config.js", import.meta.url).href, {
  namedExports: { config: { bot: {}, token: ["bot1:appid:token:secret:1:0"] }, configSave: async () => {} },
})
mock.module(new URL("../lib/converter.js", import.meta.url).href, { namedExports: { Converter: class {} } })
mock.module(new URL("../lib/client.js", import.meta.url).href, {
  namedExports: {
    joinRequestComment: () => "",
    connectBot: async (_adapter, token) => {
      const id = token.split(":")[0]
      attempts.push(token)
      const result = results.shift()
      Bot[id] = { sdk: { stop: async () => { stops++ } } }
      if (result instanceof Error) {
        Bot[id].loginError = result
        return false
      }
      return true
    },
  },
})
mock.module(new URL("../lib/uinMap.js", import.meta.url).href, {
  namedExports: { loadMappingsFromFile: async () => {}, isQQUin: () => false },
})
mock.module(new URL("../lib/groupMap.js", import.meta.url).href, { namedExports: { loadMappingsFromFile: async () => {} } })
mock.module(new URL("../lib/messageSender.js", import.meta.url).href, { namedExports: { installMessageSender () {} } })
mock.module(new URL("../lib/messageStore.js", import.meta.url).href, { namedExports: {} })
mock.module(new URL("../app/qrlogin.js", import.meta.url).href, { namedExports: { QRLoginPlugin: class {} } })

mock.timers.enable({ apis: ["setTimeout"] })
await import("../index.js")
const adapter = Bot.adapter.at(-1)
const flush = () => new Promise(resolve => setImmediate(resolve))

await test("启动时连接失败：30 秒、60 秒后重试，连上后不再重试", async () => {
  results = [new Error("network down"), new Error("network down"), true]
  await adapter.load()
  assert.equal(attempts.length, 1)

  mock.timers.tick(29 * 1000)
  await flush()
  assert.equal(attempts.length, 1)
  mock.timers.tick(1000)
  for (let i = 0; i < 5; i++) await flush()
  assert.equal(attempts.length, 2)
  assert.equal(stops, 1)

  mock.timers.tick(60 * 1000)
  for (let i = 0; i < 5; i++) await flush()
  assert.equal(attempts.length, 3)

  mock.timers.tick(30 * 60 * 1000)
  for (let i = 0; i < 5; i++) await flush()
  assert.equal(attempts.length, 3)
})

await test("重试间隔最长 10 分钟", async () => {
  attempts.length = 0
  results = [new Error("down"), true]
  assert.equal(await adapter.connect("bot2:appid:token:secret:1:0", 8), false)
  mock.timers.tick(10 * 60 * 1000 - 1)
  await flush()
  assert.equal(attempts.length, 1)
  mock.timers.tick(1)
  for (let i = 0; i < 5; i++) await flush()
  assert.equal(attempts.length, 2)
})

await test("AppID 或密钥错误时不重试", async () => {
  attempts.length = 0
  results = [Object.assign(new Error("invalid appid or secret"), { code: 100016 })]
  assert.equal(await adapter.connect("bot3:appid:token:secret:1:0"), false)
  mock.timers.tick(60 * 60 * 1000)
  for (let i = 0; i < 5; i++) await flush()
  assert.equal(attempts.length, 1)
  assert.match(String(logs.at(-1)[1]), /不再自动重试/)
})

mock.timers.reset()
