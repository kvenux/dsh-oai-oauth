/** Plugin-scoped HTTP proxy configuration and fetch implementation. */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { FetchFunction } from '@earendil-works/pi-ai'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

export const PROXY_SETTINGS_NAMESPACE = settingsNamespace('oai-oauth')

/** Persisted transport settings used only by this plugin. */
export interface ProxySettings {
  enabled: boolean
  url: string
}

/** Root composition settings and settings-file schema. */
export const ProxySettingsSchema: z<ProxySettings> = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:7890'),
})

/** Reject unsupported or credential-bearing proxy URLs before persistence. */
export function validateProxySettings(settings: ProxySettings): void {
  if (!settings.enabled) return
  let parsed: URL
  try {
    parsed = new URL(settings.url)
  } catch {
    throw new TypeError('代理地址必须是完整 URL，例如 http://127.0.0.1:7890')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('代理地址只支持 http:// 或 https://')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError('代理账号密码请勿写入设置文件；当前只支持无需认证的代理')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** HTTP transport isolated to the OpenAI OAuth plugin. */
    openaiProxy: OpenAIProxyService
  }
}

/** Owns proxy dispatchers without changing process environment or global fetch. */
export class OpenAIProxyService extends Service {
  private readonly agents = new Map<string, ProxyAgent>()
  private source: () => ProxySettings
  private fallback: ProxySettings

  constructor(ctx: Context, entry: ProxySettings) {
    super(ctx, 'openaiProxy')
    validateProxySettings(entry)
    this.fallback = { ...entry }
    this.source = () => this.fallback
    installSettingsSection(ctx, PROXY_SETTINGS_NAMESPACE, ProxySettingsSchema, entry, {
      setSource: source => { this.source = source },
      onChange: () => {},
      validate: validateProxySettings,
    })
    ctx.effect(() => () => {
      for (const agent of this.agents.values()) void agent.close()
      this.agents.clear()
    }, 'dsh-oai-oauth: close plugin-scoped proxy dispatchers')
  }

  /** Return the current non-secret settings snapshot. */
  settings(): ProxySettings {
    return { ...this.source() }
  }

  /** Persist settings when DSH settings exist, otherwise apply them for this process. */
  async save(next: ProxySettings): Promise<void> {
    validateProxySettings(next)
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      this.fallback = { ...next }
      this.source = () => this.fallback
      return
    }
    await settings.replace(PROXY_SETTINGS_NAMESPACE, next)
  }

  /** Build a fetch function that routes only this plugin's requests through the configured proxy. */
  fetch(): FetchFunction | undefined {
    const settings = this.source()
    if (!settings.enabled) return undefined
    let agent = this.agents.get(settings.url)
    if (agent === undefined) {
      agent = new ProxyAgent(settings.url)
      this.agents.set(settings.url, agent)
    }
    const dispatcher = agent
    return ((input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
      const requestInit = { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]
      return undiciFetch(input as Parameters<typeof undiciFetch>[0], requestInit) as unknown as ReturnType<FetchFunction>
    }) as FetchFunction
  }
}
