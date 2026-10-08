# opencode-go-usage

OpenCode 插件：查询 [OpenCode Go](https://opencode.ai/docs/go/) 订阅用量。

## 功能

- 提供 `go_usage` 工具，查看 5 小时 / 每周 / 每月三个窗口的已用百分比、重置时间与限流状态
- 提供 `/go-usage` 命令，输入 `/go` 即可补全
- 会话空闲时自动检查用量，任一窗口达到 90% 或已限流时弹出 TUI 预警（同一重置周期只提醒一次）
- 60 秒结果缓存；API Key 自动从 OpenCode auth.json 读取，兼容 macOS / Linux / Windows 路径

## 安装

要求：已安装 OpenCode，并通过 `/connect` 连接 OpenCode Go。

```sh
git clone https://github.com/spotsking/go_usage.git
cd go_usage
bash install.sh
```

重启 OpenCode 后生效。脚本会把 `go-usage.ts` 复制到 `~/.config/opencode/plugins/`、`go-usage.md` 复制到 `~/.config/opencode/command/`；若 `~/.config/opencode/package.json` 不存在，则用仓库内的版本创建（含 `@opencode-ai/plugin` 依赖，OpenCode 启动时会自动安装）。

更新：

```sh
git pull
bash install.sh
```

## 使用

- 输入 `/go-usage`（输入 `/go` 自动补全）
- 让 AI 调用 `go_usage` 工具（`refresh: true` 可跳过 60 秒缓存）
- 也可以直接说「查看 go 用量」

## 配置

可通过环境变量提供 API Key（优先级高于 auth.json）：

- `OPENCODE_GO_API_KEY`
- `OPENCODE_AUTH_CONTENT`（auth.json 的完整内容）
