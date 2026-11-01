# QQBot-Plugin

> 基于 [Yunzai-QQBot-Plugin](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin) 拆分二改的 QQ 官方 Bot 适配器插件。

## 项目说明

本插件用于让 Yunzai 接入 QQ 官方 Bot 能力，将 QQBot 的私聊、群聊、频道事件转换为 Yunzai 可处理的事件，并把 Yunzai 的消息段转换为 QQBot 可发送的消息格式。

- 原作者：时雨
- 原项目：https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin
- 当前版本：在原项目基础上进行模块拆分、结构调整与功能补充
- `wiki.md`：整理了按钮、Markdown 等 QQBot 消息组件用法
- 参考实现（wind-trace 版官方 Bot 适配器，两个平台内容相同）：
  - GitCode：https://gitcode.com/wind-trace/Yunzai-QQBot-Plugin
  - Gitee：https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin

> 感谢原作者的开源贡献。本项目为二改拆分版本，遇到与原版差异时请以当前项目代码为准。

## 功能简介

- 接入 QQ 官方 Bot 私聊、群聊、频道消息事件
- 支持 Yunzai 常用消息段到 QQBot 消息的转换
- 支持文本、图片、Markdown、按钮等消息发送
- 支持 C2C 私聊文本与 Markdown 流式发送
- 支持 `openid` 与真实 QQ 号的绑定映射
- 支持 QQBot 群 `openid` 与真实群号的绑定映射
- 支持从群消息事件中提取成员名称与身份信息
- 支持扫码登录添加 QQBot 配置，扫码后直接上线
- 支持机器人入群 / 退群、主动消息开关等通知事件
- 启动时连接失败自动重试
- 支持频道、群聊、私聊的基础撤回与发送能力

## 环境要求

- 已安装并可正常运行 Yunzai / TRSS-Yunzai
- Node.js 环境需满足当前 Yunzai 运行要求
- Redis 需正常可用，用户与群映射会写入 Redis
- QQ 官方 Bot 需要已在 QQ 开放平台创建并具备对应事件权限

## 安装教程 

插件使用的 `qq-official-bot` SDK为fork二改 并通过 pnpm 本地链接加载。进入插件目录后安装依赖 详情请查看lib\modules\qq-official-bot下的README.md
```bash
git clone --depth 1 https://github.com/dndss/Yunzai-QQBot-Plugin ./plugins/QQBot-Plugin
cd plugins/QQBot-Plugin
pnpm install
```



如果 `sharp` 安装失败，请根据当前系统环境检查 Node.js 版本、网络源、编译环境或预编译包下载情况。

## 配置文件

配置文件位于：

```text
Yunzai/config/QQBot.yaml
```

首次启动后会自动生成默认配置，默认配置大致如下：

```yaml
tips:
  - 欢迎使用 TRSS-Yunzai QQBot Plugin ! 作者：时雨🌌星空
  - 参考：https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin
toBotUpload: true
hideGuildRecall: false
imageLength: 10
markdownImage: false
forceVerifyImageResource: false
messageRetentionDays: 7
forwardMarkdown: true
inputNotify: true
filterBotMsg: false
filterOnlyAtOtherBot: false
bot:
  maxRetry: 10
  timeout: 30000
token: []
```

### 配置项说明

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `toBotUpload` | `true` | 语音是否优先通过其他 Bot 上传；Markdown 图片始终使用当前 QQBot 的官方素材接口 |
| `hideGuildRecall` | `false` | 频道撤回时是否隐藏相关提示 |
| `imageLength` | `10` | 图片压缩阈值，单位 MiB（`1024 * 1024` 字节）；超过阈值时尝试压缩，未超过时保留原图 |
| `markdownImage` | `false` | 是否将群聊和 C2C 私聊中的普通图片消息段上传为官方素材并转换成 Markdown 图片；默认仍以原生图片发送 |
| `forceVerifyImageResource` | `false` | 是否为群聊和 C2C 私聊 Markdown 开启图片资源转存校验。开启后，图片转存失败会中断发送并记录错误，不自动重试。频道消息不受影响 |
| `messageRetentionDays` | `7` | 群聊和 C2C 私聊的 JSONL 聊天记录保留天数。设置为 `0` 时永久保留，不自动删除 |
| `forwardMarkdown` | `true` | 群聊和 C2C 私聊中只有文字的合并转发转成一条 Markdown 发送，见「合并转发」 |
| `inputNotify` | `true` | 收到 C2C 私聊消息时显示“对方正在输入”（30 秒，机器人回复后自动结束）；插件也可以调用 `e.sendInputNotify(秒数)` 手动显示 |
| `filterBotMsg` | `false` | 丢弃其他机器人发的消息，避免多个机器人互相触发 |
| `filterOnlyAtOtherBot` | `false` | 丢弃只 @ 了其他机器人、没有 @ 本机器人的群消息 |
| `bot.maxRetry` | `10` | QQBot 请求最大重试次数 |
| `bot.timeout` | `30000` | QQBot 其他接口的请求超时时间，单位毫秒；普通消息发送不使用此超时 |

普通消息发送取消单次请求超时，已有的 `messageTimeout` 配置不再使用。
携带 `msg_id` 的消息收到 `40054005` 时，内置 SDK 会从当前序号继续递增重试，最多到 `5`；
仍然冲突时将最后一次 `40054005` 抛给适配器，由适配器移除被动凭据并尝试一次主动发送；SDK 不转主动。
被动发送从原消息时间计算 5 分钟截止时间，请求在这期间持续等待；
到期后取消被动请求，只尝试一次主动发送，主动发送失败后丢弃。
腾讯返回 `304103`、`40034005`（消息 ID 过期）、`40034026`（事件 ID 过期）、
`40034027`（事件不支持回复）、`40034128`（被动回复时间或次数超限）或 SDK 最终抛出的 `40054005` 时，即使未到本地截止时间，
也会移除被动回复凭据、保留已有引用索引，并只尝试一次主动发送；失败后记录两次错误并丢弃。
错误码依据官方[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
和[单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)文档；
主动发送仍受权限与频控限制。已经是主动发送的消息不会因上述错误再次重发。
其他提前返回的接口或网络失败仍直接记录错误并丢弃，不重试或提前转主动。
同一消息的 5 次被动回复上限仍保留，达到上限后直接尝试一次主动发送。
最终发送失败只打印一次 error 日志，错误详情使用 `err_code`、`message`、`trace_id` 三个字段。
被动发送和主动兜底均失败时，分别放在 `reply_failure`、`active_failure` 中；完整请求与错误堆栈记录在 debug 日志。

### Markdown 折叠块

官方 Markdown 不支持 HTML 折叠块 `<details><summary>标题</summary>内容</details>`，带有它的消息会发送失败。
群聊和私聊发送前会把折叠块展开成普通 Markdown：标题加粗单独一行，内容照常显示；代码块、行内代码里的不处理。

### Markdown 图片素材

设置 `markdownImage: true` 后，群聊和 C2C 私聊的 `segment.image(file)` 会使用当前
QQBot 的 `materialService.uploadImage()` 上传图片，将返回的 `qqbot-media://` 引用
写入 Markdown，不再通过其他 Bot 或 `Bot.fileToUrl()` 获取图床地址。
支持本地路径、Buffer、Base64 和可下载的 HTTP/HTTPS 图片 URL。

默认压缩阈值为 10 MiB，小图片保留原始内容；超过阈值时沿用现有压缩逻辑。
上传文件名、MIME 类型和宽高按压缩后的实际图片内容确定，仅支持 PNG、JPEG、GIF、WebP。
压缩后仍超过 SDK 的 10 MiB 上限、格式不支持或上传失败时，中断本次发送并抛出错误。

每次发送任务独立记录本次上传的素材，在所有消息及被动转主动发送结束后删除。
消息转换中途失败也会回收已上传素材；删除失败只记录错误，不改变消息发送结果。
官方发送时已转存图片副本，因此删除素材不影响已经发出的消息。
手动写入 Markdown 的公网图片地址和已有素材引用会保持原样，不会被自动上传或删除。
自动生成的素材引用仅供本次发送使用，聊天记录中的原始引用不能作为后续发送的可复用地址。

官方默认每个机器人最多 100 张素材；临时素材在发送结束前仍占用额度，额度不足时报错，
不会自动删除其他素材。该流程不改变频道、原生图片及私聊流式消息的发送方式。
平台规则参见[官方素材管理文档](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html)。

素材生命周期测试不连接 QQ，也不加载真实账号配置，见下方「测试」。

### URL 文件上传

群聊和私聊发送 `file` 消息段时，如果文件来源是 HTTP/HTTPS URL，插件会在调用
QQBot SDK 前将文件流式缓存到 `temp/QQBot/file-upload`，再以本地路径交给 SDK
分片上传。缓存文件会在该条消息发送成功或失败后立即删除；回复失败转主动发送时
会复用同一缓存文件。

普通文件的硬限制为 200 MiB（`200 * 1024 * 1024` 字节）：

- URL 提供有效 `Content-Length` 且超过限制时，不下载文件，直接返回“文件过大”。
- 无法提前确定大小时，下载过程中实时累计字节数；超过限制会立即中止并删除残片。
- 该处理仅应用于 `file` 消息段，不改变图片、视频和语音的现有发送逻辑。


## 添加 Bot 账号

### 方式一：扫码登录

推荐使用扫码方式自动写入配置：控制台发送
```text
#QQbot扫码登录
```

说明：

- 二维码有效期约 1 分钟
- 扫码成功后会自动写入 `QQBot.yaml`，并直接连接新账号，不用重启
- 同一时间只能进行一个扫码流程

### 方式二：手动配置 Token

也可以手动编辑 `QQBot.yaml` 的 `token` 列表：

```yaml
token:
  - 机器人QQ号:appid:token:secret:群私聊事件开关:频道事件开关
```

示例：

```yaml
token:
  - 123456789:102000000:你的token:你的secret:1:0
```

字段说明：

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| 第 1 段 | 机器人 QQ 号 | 当前 QQBot 对应的机器人 QQ 号 |
| 第 2 段 | `appid` | QQ 开放平台应用 AppID |
| 第 3 段 | `token` | QQBot Token |
| 第 4 段 | `secret` | QQBot Secret |
| 第 5 段 | 群私聊事件开关 | `1` 启用群聊/私聊事件，`0` 不启用 |
| 第 6 段 | 频道事件开关 | `0` 使用公开频道事件，`1` 使用私域频道事件 |

第 5 段启用后主要处理：

- `GROUP_AT_MESSAGE_CREATE`
- `C2C_MESSAGE_CREATE`

第 6 段说明：

- `0`：使用公开频道 `PUBLIC_GUILD_MESSAGES`
- `1`：使用私域频道 `GUILD_MESSAGES`

## 常用命令

| 命令 | 权限 | 使用场景 |
| --- | --- | --- |
| `#QQbot扫码登录` | `master` | 扫码授权并自动写入 Bot 配置 |
| `#QQ绑定` | QQBot 私聊/群聊用户 | 查看 QQ 号绑定提示 |
| `#QQ绑定123456789` | QQBot 私聊/群聊用户 | 将当前 QQBot `openid` 绑定到真实 QQ 号 |
| `#QQ绑定@某人 123456789` | `master` | 校验被 @ 用户头像后代为绑定 |
| `#QQ强制绑定@某人 123456789` | `master` | 跳过头像校验，直接为被 @ 用户绑定 |
| `#QQ绑定openid <openid> 123456789` | `master` | 校验指定 `openid` 的头像后直接绑定 |
| `#QQ强制绑定openid <openid> 123456789` | `master` | 跳过头像校验，直接绑定指定 `openid` |
| `#群绑定` | `master` | 查看当前群绑定状态或绑定提示 |
| `#群绑定123456789` | `master` | 将当前 QQBot 群 `openid` 绑定到真实群号 |

消息过滤开关 `filterBotMsg`、`filterOnlyAtOtherBot` 直接修改 `QQBot.yaml`，见「配置项说明」。

## 绑定映射

QQ 官方 Bot 事件中通常拿到的是 `openid`，不是传统 QQ 号或群号。为了兼容依赖真实 QQ 号/群号的 Yunzai 插件，
本插件维护 `openid` 与真实 QQ 号、群 `openid` 与真实群号的映射（Redis + `data/QQBot/` 下的 JSON 文件）：

- 收到消息时，已绑定用户的 `user_id` 换成 QQ 号，已绑定群的 `group_id` 换成群号；原始值保留在 `_raw_user_id`、`_raw_group_id`
- 发送、撤回、群管理等操作传入 QQ 号或群号时，自动换回 `openid` 调用官方接口

其他插件也可以通过 `adapter.mapping` 查询、保存绑定，见下方「扩展接口」。

### 用户绑定

用户在 QQBot 私聊或群聊中发送：

```text
#QQ绑定123456789
```

插件会通过头像 MD5 对比校验当前 `openid` 与真实 QQ 号是否一致，校验通过后写入映射。

群聊中，已完成自身 QQ 绑定的 `master` 可以代其他用户绑定：

```text
#QQ绑定@某人 123456789
```

普通代绑定会校验被 @ 用户头像。头像无法匹配时，`master` 可以明确使用强制命令：

```text
#QQ强制绑定@某人 123456789
```

强制代绑定会跳过头像校验，请确认 QQ 号和被 @ 用户无误后再使用。每次只能指定一名用户。

无法 @ 到目标用户，但已经从日志等位置取得其 `openid` 时，可以直接指定 32 位 `openid`：

```text
#QQ绑定openid A1B2C3D4E5F60718293A4B5C6D7E8F90 123456789
```

普通 OPENID 绑定仍会校验目标头像。需要跳过头像校验时使用：

```text
#QQ强制绑定openid A1B2C3D4E5F60718293A4B5C6D7E8F90 123456789
```

这两条命令仅限 `master` 使用，同时支持 QQBot 私聊和群聊。

### 群绑定

群内 `master` 发送：

```text
#群绑定123456789
```

绑定成功后，当前 QQBot 群 `openid` 会映射为真实群号。

## 群成员信息

QQ 官方的群成员列表与成员详情接口目前仅向内邀机器人开放（未开通返回 `11253`），
插件不依赖这两个接口，直接使用群消息事件中的 `author` 字段：

- `author.username` 封装为 `sender.nickname`
- `author.member_role` 同步为 `role`、`member_role`、`is_owner` 和 `is_admin`
- `author.bot` 和 `author.union_openid` 直接保留到 `sender`
- 事件未提供 `sender.card`、`joined_at` 或 `join_time` 时，插件不会自行补造

已开通内邀权限的机器人可以通过内置 SDK 直接调用
`Bot[id].sdk.getGroupMemberList(groupOpenid)`（自动翻页）和
`Bot[id].sdk.getGroupMemberInfo(groupOpenid, memberOpenid)`。

## 入群申请

机器人是群管理员时，开放平台推送的入群申请（`GROUP_JOIN_REQUEST`）会转成 Yunzai 的
`request.group.add` 事件（被邀请的申请为 `request.group.invite`），写法与野生号相同：

- `e.user_id` 为申请人（已绑定 QQ 时为 QQ 号），`e.nickname` 为昵称
- `e.comment` 为验证信息：填写的验证消息，或问答题的“问题：…\n答案：…”；原始结构在 `e.verify_info`
- `e.flag`（同 `e.join_request_id`）为申请 ID
- `e.approve(true)` 同意，`e.approve(false, 理由, true)` 拒绝并加入群黑名单
- `e.reply(msg)` 在群里发主动消息（入群申请不支持被动回复）

本插件只负责把申请转成事件，不发提醒；需要入群申请提醒（如带同意 / 拒绝按钮的消息）时，
可以在其他插件里监听 `request.group.add` 事件实现。ChatGPT-Plugin 的 `join_request` 工具可以查看、同意、拒绝。

群对象也可以主动查询和处理：

- `Bot[id].pickGroup(群号).getJoinRequestList()`：待处理的申请，每条带 `user_id`、`nickname`、`comment`、`flag`
- `Bot[id].pickGroup(群号).setAddRequest(user_id, flag, approve, reason, block)`：同意或拒绝

## 机器人入群 / 退群、主动消息开关

- 机器人被拉进群、被移出群时触发 `notice.group.increase` / `notice.group.decrease`，
  按 Yunzai 惯例 `e.user_id` 为机器人自己，`e.operator_id` 为操作人。
  入群事件可以直接 `e.reply(msg)` 发欢迎、自我介绍（使用 event_id 被动回复）；退群后群列表里的这个群会被移除
- 群里开启、关闭「接收机器人主动消息」时触发 `notice.group.receive_open` / `notice.group.receive_close`，
  好友开启、关闭时触发 `notice.friend.receive_open` / `notice.friend.receive_close`；
  `e.allow_proactive_msg` 为开关状态，开启事件可以 `e.reply(msg)` 被动回复。群开关状态同时记在群列表的 `allow_proactive_msg` 上

频道、子频道、表情表态、论坛等通知暂不转换，只在 debug 日志中记录。

## 好友事件与分享链接

用户添加、删除机器人时触发 Yunzai 的 `notice.friend.increase` / `notice.friend.decrease` 事件，
`e.user_id` 为用户（已绑定时为 QQ 号）。好友新增事件可以直接 `e.reply(msg)` 回复（使用 event_id 被动回复）。

`Bot[id].getGenerateUrl(callback_data)` 生成机器人的分享链接，`callback_data` 最长 32 个字符。
用户通过这个链接添加机器人时，好友新增事件的 `e.callback_data` 就是这里传入的数据，可以用来区分推广渠道、邀请人等；
其他来源添加时 `e.callback_data` 为空，来源编号在 `e.scene`（2003 / 2004 为分享链接）。
据参考实现的作者实测，只有 Webhook 模式能收到 `callback_data`，WebSocket 模式收不到。

## 群黑名单

需要机器人是群管理员。黑名单里的成员不能再申请加群：

- `Bot[id].pickGroup(群号).getBlacklist()`：黑名单成员，每条带 `user_id`（已绑定时为 QQ 号）、`nickname`
- `Bot[id].pickGroup(群号).setBlacklist(user_ids, true)`：加入黑名单，`false` 为移出；可传一个或多个（单次最多 20 个），
  返回值的 `fail_user_ids` 为操作失败的成员
- 踢人时拉黑：`kickMember(user_id, true)`；拒绝入群申请时拉黑：`e.approve(false, 理由, true)`

插件内置经过验证的维护版 `qq-official-bot` SDK 运行快照，不再从远程仓库安装 SDK 本体。


## 目录结构

```text
QQBot-Plugin
├── app
│   ├── bind.js            # #QQ绑定 命令
│   ├── groupBind.js       # #群绑定 命令
│   └── qrlogin.js         # 扫码登录命令
├── lib
│   ├── client.js          # QQBot 连接与事件转发（消息、通知、入群申请、按钮回调）
│   ├── config.js          # 配置加载与保存
│   ├── converter.js       # 消息段转换
│   ├── extensions.js      # 扩展接口（adapter.use / adapter.mapping）
│   ├── messageBuilder.js  # 收到的消息转成 Yunzai 事件
│   ├── messageSender.js   # 发送、被动转主动、撤回
│   ├── messageStore.js    # 聊天记录 JSONL 持久化与查询
│   ├── segments.js        # 扩展消息段构造器
│   ├── forwardMarkdown.js # 纯文字合并转发转 Markdown
│   ├── musicMarkdown.js   # 音乐卡片转 Markdown 链接
│   ├── unsupportedSegments.js # 发不了的卡片等消息段转换
│   ├── groupMap.js        # 群 openid 与真实群号映射
│   ├── uinMap.js          # 用户 openid 与真实 QQ 号映射
│   ├── avatarVerify.js    # 绑定时的头像校验
│   ├── modules
│   │   └── qq-official-bot  # 内置 QQBot SDK 运行产物
│   └── ...                # 素材、文件缓存、Markdown 兼容等工具
├── test                   # pnpm test 测试（mock SDK，不连接 QQ）
├── index.js               # 适配器入口
├── package.json           # 依赖信息
├── README.md              # 项目说明
└── wiki.md                # 消息组件示例文档
```

## 消息组件

按钮、Markdown、Markdown + 按钮混合发送等示例请查看：

```text
wiki.md
```

常见写法示例：

```js
await e.reply(segment.button([
  { text: "确认", callback: "#确认" },
  { text: "取消", callback: "#取消" }
]))
```

### 图文卡片

群聊和 C2C 私聊可以发送带封面图的图文卡片（`msg_type: 8`），点击打开链接：

```js
await e.reply(segment.card({
  title: "晴天",                       // 超过 50 字截断
  description: "周杰伦",               // 超过 50 字截断
  pic_url: "https://example.com/a.jpg", // http(s) 图片链接
  url: "https://y.qq.com/...",         // 必须是 https，自动追加 qq_aio_chat_type=3 在 QQ 内打开
}))
```

卡片单独作为一条消息发送，和文字一起发时文字在前。四个字段都是必填，缺少或链接不合法时发送报错。

### 其他消息段构造器

插件加载时注册到全局 `segment`，其他插件或适配器已经定义的同名构造器不会被覆盖：

| 构造器 | 说明 |
| --- | --- |
| `segment.bubble(...按钮)` | 气泡按钮，显示在输入框上方，最多 3 个，按钮写法同 `segment.button`；挂在最后一条 Markdown 消息上 |
| `segment.small()` | 本条消息的按钮改用小号字体 |
| `segment.qqbotcmd(文字, 指令, enter, reply)` | Markdown 指令文字：点击后把指令填入输入框，`enter` 为 `true` 时直接发送 |
| `segment.inlinecmd(文字, 指令, enter, reply)` | 旧版 `mqqapi://aio/inlinecmd` 指令链接，推荐优先用 `qqbotcmd` |
| `segment.link(文字, 链接)` | Markdown 跳转链接 `[🔗文字](链接)` |
| `segment.ark(模板ID, 数据)` | ark 模板消息，支持 23（文字列表）、24（大图卡片）、37（大图通知），也可用 `segment.ark23/ark24/ark37` |

`qqbotcmd`、`inlinecmd`、`link` 返回 Markdown 消息段，和文字放在同一个数组里：

```js
await e.reply(["发送 ", segment.qqbotcmd("帮助", "#帮助", true), " 查看菜单"])
await e.reply(["你好", segment.bubble({ text: "签到", callback: "#签到" }, { text: "菜单", input: "#菜单" })])
await e.reply(segment.ark37({ prompt: "通知", metatitle: "标题", metasubtitle: "副标题", metacover: "https://...", metaurl: "https://..." }))
```

ark 23 的 `list` 每项可以是文字、`[文字, 链接]` 或 `{ desc, link }`。普通消息和频道消息不支持气泡按钮，会被忽略。

### 私聊流式消息

私聊事件提供 `e.streamReply(payload, options?)`。插件会自动使用当前消息作为被动
回复凭据，但调用方仍需按 QQ 官方协议维护 `index` 和 `stream_msg_id`：

```js
const first = await e.streamReply({
  input_mode: "append",
  input_state: 1,
  index: 0,
  content_type: "markdown",
  content_raw: "正在生成回答",
  msg_seq: 1,
})

await e.streamReply({
  input_mode: "append",
  input_state: 10,
  index: 1,
  content_type: "markdown",
  content_raw: "，回答生成完毕。",
  stream_msg_id: first.id,
  msg_seq: 1,
})
```

也可以通过好友对象发送单个原始分片：

```js
await Bot[e.self_id].pickFriend(e.user_id).sendStreamMsg({
  input_state: 1,
  index: 0,
  content_type: "text",
  content_raw: "处理中",
  msg_id: e.message_id,
})
```

`sendStreamMsg()` 不会自动补充 `msg_id/event_id`；适合需要完全控制官方请求体的
场景。流式接口仅适用于 QQ C2C 私聊，不适用于频道私信。

## 聊天记录持久化

插件会将 QQ 群聊与 C2C 私聊的收发消息按天追加为 JSONL 文件：

```text
data/bots/<botId>/messages/groups/<groupOpenId>/2026-08-26.jsonl
data/bots/<botId>/messages/users/<userOpenId>/2026-08-26.jsonl
```

目录名直接使用 QQ 开放平台提供的原始 `groupOpenId` 和 `userOpenId`，不会写入
映射后的群号或 QQ 号。每行既保存便于稳定查询的标准消息字段，也保存原始数据快照：
收到的消息使用 `raw` 保存官方事件，发出的消息使用 `raw_request` 和
`raw_response` 保存实际请求与官方响应。为避免鉴权信息明文落盘，所有形式的
`auth_token` 字段都会被移除；`Buffer`、`ArrayBuffer` 和类型化数组等二进制内容
只保存类型与字节数，不会把完整字节数组写入 JSONL，其余原始字段保持不变。

引用回复、`getMsg()` 和 `getChatHistory()` 会直接查询这些文件，不再使用 7 天
Redis 消息缓存。最近收发的 5000 条消息另有内存索引，查最近的消息时不用读文件；
好友、群对象的 `getMsg()` 只查本会话的记录。

群对象和好友对象的 `getChatHistory(seq, cnt = 20)` 按 icqq 约定返回 `seq`（即 `message_id`）
及之前的 `cnt` 条消息，从早到晚排列，`seq` 那条在最后；`seq` 为空时返回最新的 `cnt` 条。

消息撤回后会追加一条 `type: "recall"` 记录。原消息行仍然保留，但后续消息查询不会
再返回该消息。

官方接口拉不到群历史消息，群对象的 `getRecentMsgs(count, direction)` 会从这些记录里
取最近的消息（已撤回的跳过，`direction` 可传 `"outgoing"` 只取机器人自己发的），
供其他插件定位并撤回机器人最近发的消息。

默认只保留最近 7 个本地自然日的记录。每个会话在当天首次写入时会检查并删除所有
过期的日期文件；可通过 `messageRetentionDays` 调整天数，设置为 `0` 可永久保留。

## SDK 生命周期与错误处理

`Bot[id].login()` 和 `Bot[id].logout()` 返回 SDK 启动、停止的 Promise，调用方应使用
`await` 或 `.catch()` 处理失败。退出直接等待 `sdk.stop()` 完成，不依赖接收器再次触发
`close` 事件；完整停止清理能力在新版 SDK 产物同步到插件后生效。

启动时连接失败（如网络还没准备好）会自动重试，间隔 30 秒起每次翻倍，最长 10 分钟；
AppID 或密钥错误时不重试，需要检查 `QQBot.yaml` 后重启。

`Bot[id].info` 只放 `id`、`appid`、头像和官方返回的机器人资料，不含 token、secret，
其他插件打印或序列化机器人信息时不会泄露密钥。

插件会在私聊、群聊、频道消息的异步入口捕获失败，并记录账号及错误。
通知事件保留原有错误处理；进程级未捕获异常继续由 Yunzai 宿主管理。

群信息查询失败后 1 分钟内不再重复请求接口，有旧的群信息时先用旧的。

## 测试

测试使用 mock SDK、配置和存储，不连接 QQ，也不加载真实账号数据。安装依赖后在插件目录运行：

```sh
pnpm test
```

插件放在 `Yunzai/plugins/` 下或单独克隆都能运行；单独克隆时用到的 Yunzai 模块由
`test/support/` 下的桩文件代替。需要 Node.js 22 及以上。

## 合并转发

官方机器人发不了合并转发。群聊和私聊中只有文字的合并转发（如 AI 的思考过程、各种列表）会转成一条
Markdown：标题加粗，每个节点一段引用块。带图片、文件等内容或超过 3000 字的合并转发不转换，
仍按普通消息拆开发送。`forwardMarkdown: false` 可关闭。

音乐卡片同样发不了，会改发一条 Markdown 链接 `🎵 歌名 - 歌手`，点开是歌曲页面。

其他发不了的消息段也不会再被当成一段 JSON 文字发出去：

- json / xml 卡片（QQ 小程序、链接分享等）取标题和跳转地址，改发 Markdown 链接 `🔗 标题`；没有地址时发 `[卡片] 标题`
- 链接分享（`share`）改发 Markdown 链接，位置（`location`）改发 `[位置] 名称 地址`
- 戳一戳、窗口抖动、匿名、骰子、猜拳等 QQ 客户端专有的消息段直接去掉
- 其他不认识的消息段有 `text` 字段时按文字发送，否则去掉

其他插件可以通过「扩展接口」先把这些内容交给别的账号发送，没发出去的才按上面处理。

## 扩展接口

适配器只负责连接 QQBot 和消息的收发、转换。其他插件需要介入发送流程，或给好友、群对象补充方法时，
通过扩展接口挂接，不要直接改写适配器的方法：

```js
const adapter = Bot.adapter.find(a => a.id === "QQBot")

adapter.use("我的扩展", {
  // 群聊 / 私聊发送前调用，scope 为 "group" 或 "friend"
  // 收到的 msg 已经过合并转发转换；next(data, msg) 交给下一个扩展，最后由适配器发送
  async send (scope, data, msg, next) {
    return next(data, msg)
  },
  // pickFriend / pickMember / pickGroup 返回对象前调用，kind 为 "friend" / "member" / "group"
  // ctx 为 { self_id, group_id, user_id }，返回（可以是修改后的）对象
  pick (kind, obj, ctx) {
    return obj
  },
})

adapter.unuse("我的扩展")
```

同名扩展重复注册时替换旧的，插件热重载不会叠加；`adapter.use()` 的返回值也可以用来移除扩展。

`adapter.mapping` 提供绑定查询与保存：`getAppid`、`getMappedUin`、`getMappedOpenid`、`saveMapping`、
`translateToOpenid`、`getGroupUin`、`translateGroupToOpenid`、`saveGroupMapping`、`checkAvatar`（头像校验）等。

`adapter.config` 是 `QQBot.yaml` 的配置对象，修改后调用 `await adapter.saveConfig()` 保存。

和野生号（OneBotv11 / ICQQ）同群共存的功能（野生号静默、野生号代发、自动 QQ 绑定等）不在本插件中，
可以通过上面的接口在其他插件里实现。

## 已知限制


- 用户映射、群映射依赖 Redis 与本地 JSON 持久化
- QQ 官方 Bot 能力受开放平台权限、事件订阅、沙箱/正式环境影响
- 部分普通 Yunzai 插件可能默认依赖真实 QQ 号，需要先完成用户或群绑定
- 当前项目为二改拆分版本，部分行为可能与原项目不完全一致

## 免责声明

本项目为基于原项目拆分后的二改版本，仅供学习交流和自用参考。使用 QQ 官方机器人能力时，请遵守 QQ 开放平台相关规则与协议。因使用本插件造成的问题需由使用者自行承担。
