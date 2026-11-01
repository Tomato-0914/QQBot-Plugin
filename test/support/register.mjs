/**
 * 测试入口：插件单独克隆、不在 Yunzai/plugins 下时，补上测试用到的 Yunzai 模块桩
 * 用法：node --import ./test/support/register.mjs --test ...（pnpm test 已带上）
 */
import { register } from "node:module"

register("./yunzai-stub.mjs", import.meta.url)
