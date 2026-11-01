// Yunzai lib/plugins/config.js 的测试桩（插件单独克隆时使用，见 test/support/yunzai-stub.mjs）
export default async (_name, config) => ({
  config: structuredClone(config),
  configSave: async () => {},
})
