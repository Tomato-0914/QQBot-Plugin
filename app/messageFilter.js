/**
 * 机器人消息过滤开关（lib/messageFilter.js）
 *   #QQBot开启bot消息过滤 / #QQBot关闭bot消息过滤：其他机器人发的消息
 *   #QQBot开启纯at其他bot过滤 / #QQBot关闭纯at其他bot过滤：只 @ 了其他机器人的群消息
 * 「QQBot」可省略，bot 也可以写成「机器人」，at 也可以写成「艾特」
 */
import plugin from "../../../lib/plugins/plugin.js"
import { config, configSave } from "../lib/config.js"

const SWITCHES = [
  { key: "filterBotMsg", name: "bot 消息过滤", desc: "其他机器人发的消息不再处理" },
  { key: "filterOnlyAtOtherBot", name: "纯 @ 其他 bot 过滤", desc: "只 @ 了其他机器人、没有 @ 我的群消息不再处理" },
]

export class MessageFilterPlugin extends plugin {
  constructor () {
    super({
      name: "QQBot消息过滤",
      dsc: "过滤其他机器人的消息、只 @ 其他机器人的消息",
      event: "message",
      priority: 0,
      rule: [
        { reg: /^#(QQBot)?(开启|关闭)(bot|机器人)(消息)?过滤$/i, fnc: "botMsg", permission: "master" },
        { reg: /^#(QQBot)?(开启|关闭)纯(at|艾特)其他(bot|机器人)过滤$/i, fnc: "onlyAtOtherBot", permission: "master" },
      ],
    })
  }

  botMsg (e) {
    return this.toggle(e, SWITCHES[0])
  }

  onlyAtOtherBot (e) {
    return this.toggle(e, SWITCHES[1])
  }

  async toggle (e, item) {
    const on = e.msg.includes("开启")
    config[item.key] = on
    await configSave()
    return this.reply(on ? `已开启${item.name}：${item.desc}` : `已关闭${item.name}`)
  }
}
