/**
 * Yunzai 模块桩（模块加载钩子）
 *
 * 插件代码和测试按 Yunzai/plugins/QQBot-Plugin 的位置引用 ../../../lib/... 下的 Yunzai 模块。
 * 这些文件不存在时（单独克隆插件仓库）改用 test/support/yunzai/ 下的同名桩文件；
 * 放在 Yunzai 里运行时仍用 Yunzai 自己的文件。测试里 mock.module 的模拟优先于桩文件。
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const STUB_ROOT = new URL("./yunzai/", import.meta.url)
const STUBS = ["lib/plugins/plugin.js", "lib/plugins/loader.js", "lib/plugins/config.js", "lib/config/config.js"]

export async function resolve (specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" || !context.parentURL) throw err
    const url = new URL(specifier, context.parentURL)
    if (url.protocol !== "file:" || existsSync(fileURLToPath(url))) throw err
    const name = STUBS.find(stub => url.href.endsWith(`/${stub}`))
    if (!name) throw err
    return { url: new URL(name, STUB_ROOT).href, shortCircuit: true }
  }
}
