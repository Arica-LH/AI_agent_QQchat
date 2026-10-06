# QQ Chat Bridge

本地 OneBot v11 反向 WebSocket 桥接服务：NapCat 接收 QQ 消息，由 DeepSeek 官方 API、Codex CLI 或 dsh 处理，再由机器人回复。

## 依赖

- DeepSeek 官方 API，或 macOS 上已安装并登录的 Codex CLI，或已配置凭据的 dsh：`dsh --profile headless --help`
- Node.js 20 或更高版本
- NapCat 或其他支持 OneBot v11 反向 WebSocket 的实现

## 安装

```sh
git clone https://github.com/Arica-LH/AI_agent_QQchat.git
cd AI_agent_QQchat
npm install
cp .env.example .env
```

编辑 `.env`：将 `BOT_QQ_ID` 设置为登录 NapCat 的机器人账号，将 `ALLOWED_USER_IDS` 设置为允许操控机器人的其他 QQ 用户账号（不要填机器人自身账号），并设置只有你能使用的随机 `ONEBOT_ACCESS_TOKEN`。`PROJECT_DIR` 是后端可操作的项目目录。首次建议指向一个测试项目；`workspace-write` 会允许后端在该目录内编辑文件和运行命令。

使用 DeepSeek 官方 API 时，将以下配置写入 `.env`，并把 `DEEPSEEK_API_KEY` 换成你的密钥：

```sh
CHAT_BACKEND=official
DEEPSEEK_API_KEY=sk-你的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_REASONING_EFFORT=high
DEEPSEEK_MAX_TOKENS=4096
```

官方 API 的对话历史保存在 `data/official_sessions.json`，每个私聊用户或群内用户独立保存；发送 `/new` 会清空对应历史。`DEEPSEEK_REASONING_EFFORT` 可设置为 `low`、`medium`、`high` 等 provider 支持的等级。官方 API 模式不具备 dsh/Codex 的本地文件工具能力，但会把收到的图片转换为 Base64 `image_url` 内容发送给支持视觉的模型。

要使用 dsh，将以下配置加入 `.env`：

```sh
CHAT_BACKEND=dsh
CHAT_DSH_BIN=dsh
CHAT_DSH_PROFILE=headless
CHAT_DSH_HOME=/absolute/path/to/your/.dsh
CHAT_DSH_PATCH=/absolute/path/to/your/.dsh/profiles/web/cordis.patch.yml
```

`CHAT_DSH_HOME` 和 `CHAT_DSH_PATCH` 的路径需要替换为自己的绝对路径；使用 dsh 默认目录且不需要 Web 配置时可留空。

`CHAT_DSH_PATCH` 会把 dsh Web 保存的 profile 配置叠加到 headless profile；凭据本身由 dsh 统一读取 `~/.dsh/.credentials.yaml`，不会复制到 QQ 桥接项目。先在同一用户环境中确认 `dsh --profile headless --patch /absolute/path/to/your/.dsh/profiles/web/cordis.patch.yml "回复 PONG"` 可以正常运行。dsh 的会话 ID 会保存在现有的 `data/sessions.json` 中，并通过 `--session-id` 恢复。

可在本地 `.env` 中通过 `DEFAULT_PERSONA` 设置机器人的角色和性格。公开版本使用通用助手提示，该提示会随每条用户消息发送；修改后重启桥接服务即可生效。

启动桥接服务：

```sh
npm start
```

启动后打开 `http://127.0.0.1:3001/`，可以在本地管理页面中切换 Codex CLI、dsh 和官方 API，填写模型、白名单、路径和人格提示。页面会实时列出待保存的字段和新值；密钥只显示“已修改”，不会回显。点击“仅保存”只写入 `.env`，点击“保存并重启”会先保存再重启服务。若直接点击顶部“重启服务”时仍有修改，页面会要求先保存。

管理页面会写入当前项目目录的 `.env`，并保留没有在页面修改的密钥。不要把页面暴露到公网；如果将 `HOST` 改为 `0.0.0.0`，请在反向代理或防火墙层增加认证。

## 配置 NapCat

在 NapCat 的 WebSocket 客户端/反向 WebSocket 设置中添加：

- 地址：`ws://127.0.0.1:3001/onebot/v11/ws`
- Access Token：与 `.env` 中 `ONEBOT_ACCESS_TOKEN` 相同

先启动桥接服务，再启动 NapCat。NapCat 的反向 WebSocket 应通过 `Authorization: Bearer <token>` 或 `x-client-token` 请求头传 token。只在本机运行时保持 `HOST=127.0.0.1`，不要将监听端口暴露到公网。

macOS 上，`npm start` 不会自动拉起 QQ/NapCat；桥接服务和 QQ/NapCat 是两个独立进程。可另开终端启动已安装的 QQ/NapCat：

```sh
open -a /Applications/QQ.app
```

## 使用

- 私聊机器人后直接发送任务。
- 群聊中仅处理 `.env` 的 `ALLOWED_GROUP_IDS` 里的群消息。
- 群聊消息包含 @ 时，只有 @ `BOT_QQ_ID` 对应账号才会触发回复；没有 @ 的群消息按白名单处理。
- 带引用的消息只有在被引用消息由 `BOT_QQ_ID` 对应账号发送时才会触发回复。
- 群聊上下文会附带发送者的 QQ 号、昵称/群名片和群身份；机器人可以据此区分发言成员。完整群成员名单需要额外调用 OneBot 群成员 API。
- `/new`（或 `\\new`）清空当前 QQ 用户（群聊中为该群该用户）的会话。
- `/help`（或 `\\help`）查看命令。
- `/members`（或 `\\members`）在群聊中列出当前群成员、QQ 号、群名片和群身份。
- `/models`（或 `\\models`）列出当前后端模型；dsh 会列出内置模型和 Web 配置中的模型，官方 API 会显示 `DEEPSEEK_MODEL`。
- `/stickers`（或 `\\stickers`）列出 NapCat 账号里的 QQ 收藏表情。dsh 会读取收藏表情清单，在合适时选择并单独发送；收到收藏表情时也会把它作为图片内容交给 dsh 理解。
- `/version`（或 `\\version`）显示当前 provider、模型和推理强度；未配置推理强度时显示为“未设置，由 provider 默认处理”。
- `/time`、`/date`（或 `\\time`、`\\date`）直接查询上海时区的当前时间和日期；普通消息中询问“现在几点”“今天几号”等问法也会直接回答。普通请求发送给后端时会附带当前上海时间，减少模型自行猜测时间的情况。
- 群聊中的这些命令只有群主或管理员可以使用；普通成员发送时不会执行命令。私聊仍按私聊白名单控制。
- 询问“目前使用的模型是什么”这类简单模型问题会直接由桥接层回答，不启动后端；普通请求只发送最终回复，不附加过渡语。
- 允许的群聊中有新成员加入时，机器人会自动发送一条带 QQ @ 的欢迎词；常见固定日期节日当天，群里的第一条有效消息会触发一次庆祝语。公开版本使用通用欢迎词和节日祝福。
- 回复会根据语境自然加入中文语气词、少量颜文字、Unicode 表情和 OneBot 标准 QQ 表情；不会每句话堆表情。自定义表情包仍需先生成真实图片文件。
- 同一私聊或群聊在 `MESSAGE_DEDUP_WINDOW_MS` 时间窗口内，如果连续消息高度相似，只处理第一次，避免多段重复提问造成重复回复。引用机器人消息发送的内容会强制处理，可用来明确选择要回复的对话。
- 连续发送的多段消息会先合并再处理：普通消息默认等待 4 秒，包含图片时默认等待 12 秒，以便把“先发图、再补充问题”的输入作为一个整体。`/new`、`/help`、`/members`、`/version` 等命令会立即执行。

使用官方 API 时，通过 `DEEPSEEK_MODEL` 指定模型，`DEEPSEEK_BASE_URL` 指定兼容 API 地址，`DEEPSEEK_MAX_TOKENS` 指定最大输出 token 数。使用 Codex 时，可通过 `CODEX_MODEL` 指定模型，`CODEX_REASONING_EFFORT` 指定推理强度（例如 `medium`）；`CODEX_BIN` 可指定 Codex CLI 的完整路径。使用 dsh 时，模型由 `CHAT_DSH_PROFILE` 和可选的 `CHAT_DSH_PATCH` 配置决定，`CHAT_DSH_BIN` 可指定 dsh 的完整路径。`CODEX_TIMEOUT_MS` 同时作为单次后端请求超时时间（默认 10 分钟）。

图片发送支持已有文件转发：只有当后端确实在 `PROJECT_DIR` 内生成图片并返回 `IMAGE_PATH: <路径>` 时，桥接服务才会自动将其发送到 QQ，单张图片不超过 15 MB。当前桥接服务本身不提供图像生成模型；若后端没有可用的图像工具或写入权限，会直接说明无法生成。

回复支持 Unicode emoji、OneBot 标准 QQ 表情和 QQ 收藏表情。后端输出 `[CQ:face,id=14]` 这类代码时，桥接服务会转换成 QQ 表情段发送；如果 dsh 输出 `STICKER_ID: <收藏表情 ID>`，桥接服务会从 NapCat 收藏清单中取出对应表情并单独发送。自定义表情包需要先作为图片文件生成，再通过 `IMAGE_PATH` 发送。

群聊中后端可以在确实需要点名、提醒或直接回应某位成员时输出 `[CQ:at,qq=123456]`，桥接服务会转换成真正的 QQ @。它只会使用消息上下文中已知的 QQ 号。

发送图片时，桥接服务会优先通过 NapCat 的 `get_image` API 读取本地图片，远程图片链接只作备用；因此 NapCat 需要支持 OneBot 图片 API。如果 NapCat 本地没有图片且 Rkey 服务失效，图片仍无法获取，需要修复 NapCat 的图片缓存或 Rkey 配置。

收到图片时，用户如果同时提出问题，后端会结合图片内容回答；如果只发送图片，机器人会简短接话并等待用户说明想讨论的内容，不会主动长篇解释图片。

引用 QQ 消息后发送的内容会带上被引用消息文本；如果 NapCat 只发送引用 ID，桥接服务会通过 `get_msg` API 补取原消息。

会话 ID 保存在 `data/sessions.json`，不会提交到 Git。每个私聊用户或群内用户使用独立后端会话。群聊必须显式配置 `ALLOWED_GROUP_IDS`，机器人自身消息会忽略。

## 本地配置与版本管理

仓库仅包含源代码、依赖清单、说明文档和 `.env.example` 配置模板。真实 API 密钥、OneBot token、QQ 号、群号、本机路径和个人角色提示应填写在本地 `.env`，不要填写进模板或源代码。

`.gitignore` 已排除 `.env` 及其变体、`data/` 下的会话和聊天记录、日志、临时图片、依赖目录和本地凭据文件。dsh 的凭据及 Web profile 配置保留在自己的 dsh 目录，不要复制进仓库。首次启动前必须填写至少一类白名单、机器人 QQ 号和随机 OneBot token。

## 安全边界

- 不要将 `ALLOWED_USER_IDS` 或 `ALLOWED_GROUP_IDS` 留空或设为所有人；至少配置一类白名单。
- 后端使用 `workspace-write` 沙箱，首次会话固定在 `PROJECT_DIR`。不要把目录设为包含个人密钥或其他不相关资料的位置。
- Codex CLI 自动化调用使用 `--approve-for-me`；dsh 使用其 profile 的默认权限模式。不要改成跳过沙箱的危险选项。
- NapCat 属于第三方 QQ 接入方案，请自行评估 QQ 账号与服务条款风险。生产使用优先确认适用的官方机器人接入方式。
