// Yunzai lib/plugins/plugin.js 的测试桩（插件单独克隆时使用，见 test/support/yunzai-stub.mjs）
export default class plugin {
  constructor (options = {}) {
    Object.assign(this, options)
  }
}
