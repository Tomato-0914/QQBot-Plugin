/**
 * 机器人消息过滤：群里有多个官方机器人时，避免它们互相触发
 *   - filterBotMsg：丢弃其他机器人发的消息
 *   - filterOnlyAtOtherBot：丢弃只 @ 了其他机器人、没有 @ 本机器人的群消息（开通全量消息时，群友 @ 别的机器人也会推送过来）
 * 两项默认关闭，用 #QQBot开启bot消息过滤、#QQBot开启纯at其他bot过滤 打开
 */

const isTrue = value => value === true || value === "true"

/**
 * 这条消息是否应当丢弃
 * @returns {string} 丢弃原因；不丢弃时为空字符串
 */
export function filterReason (config, data, event) {
  if (config?.filterBotMsg && (isTrue(event?.author?.bot) || isTrue(data?.sender?.bot)))
    return "其他机器人的消息"

  if (config?.filterOnlyAtOtherBot && data?.message_type === "group" && Array.isArray(event?.mentions)) {
    const single = event.mentions.filter(m => m?.scope !== "all")
    const atSelf = single.some(m => isTrue(m.is_you))
    const atOtherBot = single.some(m => isTrue(m.bot) && !isTrue(m.is_you))
    if (atOtherBot && !atSelf) return "只 @ 了其他机器人"
  }
  return ""
}
