import assert from "node:assert/strict"
import { mock, test } from "node:test"

// Run with: node --experimental-test-module-mocks --test test/qrlogin.test.js
// 扫码登录：防止重复扫码、写入配置后直接连接新账号、日志不带 secret
const logs = []
const connected = []
let release
let saveAdded = true
global.segment = { image: file => ({ type: "image", file }) }
global.Bot = {
  makeLog: (...args) => logs.push(args),
  adapter: [{ id: "QQBot", connect: async token => { connected.push(token); return true } }],
}
mock.module(new URL("../../../lib/plugins/plugin.js", import.meta.url).href, {
  defaultExport: class { constructor (options) { Object.assign(this, options) } },
})
mock.module(new URL("../lib/qrlogin.js", import.meta.url).href, {
  namedExports: {
    startQRLogin: async () => {
      await new Promise(resolve => { release = resolve })
      return { uin: "10001", appid: "102000000", secret: "SECRET", username: "测试机器人" }
    },
    generateTokenString: (uin, appid, secret) => `${uin}:${appid}:${secret}:${secret}:1:0`,
    saveBotToken: async () => (saveAdded ? { added: true } : { added: false, msg: "该机器人已存在配置中" }),
  },
})
const { QRLoginPlugin } = await import("../app/qrlogin.js")

const run = () => {
  const replies = []
  const e = { reply: async msg => replies.push(msg) }
  return { replies, done: new QRLoginPlugin().startLogin(e) }
}

await test("扫码进行中时，新的插件实例也会拒绝再次扫码", async () => {
  const first = run()
  await new Promise(resolve => setImmediate(resolve))
  const second = run()
  await second.done
  assert.match(second.replies[0], /已有扫码流程正在进行中/)
  release()
  await first.done
})

await test("写入配置后直接连接新账号，日志不带 secret", async () => {
  connected.length = 0
  logs.length = 0
  const { replies, done } = run()
  await new Promise(resolve => setImmediate(resolve))
  release()
  await done
  assert.deepEqual(connected, ["10001:102000000:SECRET:SECRET:1:0"])
  assert.match(replies.at(-1).join(""), /机器人已上线/)
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/)
})

await test("账号已在配置中时不重复连接", async () => {
  connected.length = 0
  saveAdded = false
  const { replies, done } = run()
  await new Promise(resolve => setImmediate(resolve))
  release()
  await done
  assert.deepEqual(connected, [])
  assert.match(replies.at(-1).join(""), /已存在配置中/)
})
