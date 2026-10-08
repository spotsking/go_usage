import { tool, type Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER_ID = "opencode-go"
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const CACHE_TTL = 60_000
const WARN_PERCENT = 90
const REQUEST_TIMEOUT = 10_000

type Window = {
  status: string
  percent: number
  resetsAt: string
}

type Usage = {
  rolling: Window
  weekly: Window
  monthly: Window
}

const WINDOWS: Array<[keyof Usage, string]> = [
  ["rolling", "5 小时"],
  ["weekly", "本周"],
  ["monthly", "本月"],
]

let apiKeyOverride: string | undefined
let cache: { at: number; usage: Usage } | undefined
let inFlight: Promise<Usage> | undefined
let goActive = false
const warned = new Map<string, string>()

function authFiles() {
  const home = homedir()
  const files: string[] = []
  if (process.env.XDG_DATA_HOME) files.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  files.push(join(home, ".local", "share", "opencode", "auth.json"))
  files.push(join(home, "Library", "Application Support", "opencode", "auth.json"))
  files.push(join(home, ".config", "opencode", "auth.json"))
  return files
}

function keyFromDocument(document: unknown): string | undefined {
  if (!document || typeof document !== "object") return
  const entry = (document as Record<string, unknown>)[PROVIDER_ID]
  if (!entry || typeof entry !== "object") return
  const record = entry as Record<string, unknown>
  if (typeof record.type === "string" && record.type !== "api") return
  if (typeof record.key !== "string" || record.key.length === 0) return
  return record.key.trim()
}

function parseKey(text: string) {
  try {
    return keyFromDocument(JSON.parse(text))
  } catch {
    return undefined
  }
}

async function resolveApiKey() {
  if (apiKeyOverride) return apiKeyOverride
  const explicit = process.env.OPENCODE_GO_API_KEY
  if (explicit) return explicit

  const inline = process.env.OPENCODE_AUTH_CONTENT
  if (inline) {
    const key = parseKey(inline)
    if (key) return key
  }

  for (const file of authFiles()) {
    try {
      const key = parseKey(await readFile(file, "utf8"))
      if (key) return key
    } catch {
      // try the next candidate path
    }
  }

  throw new Error("未找到 OpenCode Go 的 API Key：请先在 TUI 中执行 /connect 并选择 “OpenCode Go”。")
}

function normalizeWindow(value: unknown): Window | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  const percent = typeof record.percent === "number" ? record.percent : Number(record.percent)
  if (!Number.isFinite(percent)) return
  return {
    status: typeof record.status === "string" ? record.status : "ok",
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: typeof record.resetsAt === "string" ? record.resetsAt : "",
  }
}

async function requestUsage(key: string): Promise<Usage> {
  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
  } catch (error) {
    throw new Error(`请求 OpenCode Go 用量失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (response.status === 401) throw new Error("OpenCode Go 的 API Key 无效或已过期，请重新 /connect。")
  if (response.status === 403) {
    const body = (await response.json().catch(() => undefined)) as { error?: { type?: string } } | undefined
    if (body?.error?.type === "EntitlementError") throw new Error("当前 OpenCode 账号没有 Go 订阅。")
    throw new Error("OpenCode Go 用量接口返回 403（无权限）。")
  }
  if (!response.ok) throw new Error(`OpenCode Go 用量接口返回 HTTP ${response.status}。`)

  const body = (await response.json().catch(() => undefined)) as { usage?: Record<string, unknown> } | undefined
  const rolling = normalizeWindow(body?.usage?.rolling)
  const weekly = normalizeWindow(body?.usage?.weekly)
  const monthly = normalizeWindow(body?.usage?.monthly)
  if (!rolling || !weekly || !monthly) throw new Error("OpenCode Go 用量接口返回了未知的数据格式。")
  return { rolling, weekly, monthly }
}

async function getUsage(refresh = false): Promise<Usage> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL) return cache.usage
  if (!inFlight) {
    const pending = (async () => {
      const usage = await requestUsage(await resolveApiKey())
      cache = { at: Date.now(), usage }
      return usage
    })()
    inFlight = pending
    pending
      .finally(() => {
        if (inFlight === pending) inFlight = undefined
      })
      .catch(() => {})
  }
  return inFlight
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char)
      ? 2
      : 1
  }
  return width
}

function padRight(text: string, width: number) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)))
}

function formatBar(percent: number, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function formatPercent(percent: number) {
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
}

function formatReset(resetsAt: string) {
  const reset = Date.parse(resetsAt)
  if (!Number.isFinite(reset)) return ""
  const ms = reset - Date.now()
  if (ms <= 0) return "即将重置"
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (days === 0 && rest > 0) parts.push(`${rest} 分钟`)
  return `${parts.join(" ")}后重置`
}

function windowStatus(window: Window) {
  return window.status === "rate-limited" || window.percent >= 100 ? "（已限流）" : ""
}

function formatUsage(usage: Usage) {
  const labelWidth = Math.max(...WINDOWS.map(([, label]) => displayWidth(label)))
  const lines = WINDOWS.map(([key, label]) => {
    const window = usage[key]
    return [
      `  ${padRight(label, labelWidth)}  ${formatBar(window.percent)}`,
      formatPercent(window.percent).padStart(5),
      formatReset(window.resetsAt),
      windowStatus(window),
    ]
      .filter(Boolean)
      .join("  ")
  })
  return ["OpenCode Go 用量", ...lines].join("\n")
}

function alertWindows(usage: Usage) {
  return WINDOWS.filter(([key]) => {
    const window = usage[key]
    return window.status === "rate-limited" || window.percent >= WARN_PERCENT
  })
}

export const GoUsagePlugin: Plugin = async ({ client }, options) => {
  if (options && typeof options.apiKey === "string" && options.apiKey.trim()) {
    apiKeyOverride = options.apiKey.trim()
  }

  return {
    "chat.headers": async (input) => {
      if (input.model?.providerID === PROVIDER_ID) goActive = true
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle" || !goActive) return
      try {
        const usage = await getUsage()
        const fresh = alertWindows(usage).filter(([key]) => warned.get(key) !== usage[key].resetsAt)
        if (fresh.length === 0) return
        for (const [key] of fresh) warned.set(key, usage[key].resetsAt)
        const message = fresh.map(([key, label]) => `${label} ${formatPercent(usage[key].percent)}`).join("  ·  ")
        await client.tui.showToast({
          body: { title: "OpenCode Go 用量预警", message, variant: "warning", duration: 8000 },
        })
      } catch {
        // silent: a failed usage probe must never break a session
      }
    },
    tool: {
      go_usage: tool({
        description:
          "查看 OpenCode Go 订阅用量（5 小时 / 每周 / 每月窗口的已用百分比与重置时间）。Show OpenCode Go subscription usage.",
        args: {
          refresh: tool.schema.boolean().optional().describe("忽略 60 秒缓存，强制刷新"),
        },
        async execute(args) {
          try {
            const usage = await getUsage(Boolean(args.refresh))
            return { title: "OpenCode Go 用量", output: formatUsage(usage) }
          } catch (error) {
            return {
              title: "OpenCode Go 用量",
              output: `查询失败：${error instanceof Error ? error.message : String(error)}`,
            }
          }
        },
      }),
    },
  }
}
