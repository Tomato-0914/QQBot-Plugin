/**
 * 野生号静默 / 一键群绑定 共用的配置与工具
 *
 * 配置保存在 Yunzai/data/wild-silence.json（沿用旧版插件的位置，升级后白名单不丢）：
 *   enable    总开关
 *   groups    静默群（真实群号）
 *   cron      静默群里野生号的定时 / 主动消息怎么处理
 *               official = 改由官方机器人发（失败时野生号照发）
 *               wild     = 野生号照发
 *               block    = 不发
 *   wild      野生号 QQ 列表，留空 = 自动识别所有 OneBotv11 / ICQQ 账号
 *   official  官方机器人 QQ，留空 = 自动取第一个在线的 QQBot 账号
 */
import fs from "node:fs"
import path from "node:path"

const FILE = path.join(process.cwd(), "data", "wild-silence.json")
const WILD_ADAPTERS = ["OneBotv11", "ICQQ"]

export const silenceConfig = { enable: true, groups: [], cron: "official", wild: [], official: "" }
try {
  if (fs.existsSync(FILE)) Object.assign(silenceConfig, JSON.parse(fs.readFileSync(FILE, "utf8")))
} catch (err) {
  logger.error(`[野生号静默] 读取配置失败：${err}`)
}

export function saveSilenceConfig() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(silenceConfig, null, 2))
}

const adapterOf = id => Bot[id]?.adapter

/** 是否野生号（非官方的 QQ 协议端账号） */
export function isWild(id) {
  if (!id) return false
  if (silenceConfig.wild?.length) return silenceConfig.wild.map(String).includes(String(id))
  return WILD_ADAPTERS.includes(adapterOf(id)?.name)
}

/** 官方机器人的账号 id，找不到返回 undefined */
export function officialId() {
  if (silenceConfig.official) return String(silenceConfig.official)
  return (Bot.uin || []).map(String).find(id => adapterOf(id)?.id === "QQBot")
}

/** 野生号在这个群是否处于静默状态 */
export function isSilenced(self_id, group_id) {
  return (
    silenceConfig.enable &&
    isWild(self_id) &&
    silenceConfig.groups.map(Number).includes(Number(group_id))
  )
}
