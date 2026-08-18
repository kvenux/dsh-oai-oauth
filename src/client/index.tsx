/** OpenAI OAuth settings page contributed to DSH's browser slot ledger. */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { HTTP_PREFIX, MUTATION_HEADER } from '../constants.ts'

interface Status {
  state: 'disconnected' | 'connected' | 'logging-in' | 'error'
  expiresAt?: number
  expired?: boolean
  error?: string
}

interface ModelRow {
  id: string
  name: string
  reasoningEfforts: string[]
}

interface ModelsPayload {
  models: ModelRow[]
  selection?: { model: string; reasoningEffort?: string }
}

interface ProxySettings {
  enabled: boolean
  url: string
}

const STYLE = `
.dsh-oai-oauth { max-width: 720px; color: var(--color-text, inherit); }
.dsh-oai-oauth h2 { margin: 0 0 8px; font-size: 20px; }
.dsh-oai-oauth p { margin: 6px 0 16px; line-height: 1.55; color: var(--color-text-secondary, #697386); }
.dsh-oai-oauth-card { border: 1px solid var(--color-border, #d9dee7); border-radius: 12px; padding: 18px; margin: 14px 0; background: var(--color-bg-elevated, transparent); }
.dsh-oai-oauth-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.dsh-oai-oauth-status { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.dsh-oai-oauth-dot { width: 9px; height: 9px; border-radius: 50%; background: #8a94a6; }
.dsh-oai-oauth-dot.connected { background: #1b9c5a; }
.dsh-oai-oauth-dot.logging-in { background: #d99000; }
.dsh-oai-oauth button { border: 0; border-radius: 8px; padding: 9px 14px; cursor: pointer; font: inherit; background: #111827; color: #fff; }
.dsh-oai-oauth button.secondary { background: transparent; color: inherit; border: 1px solid var(--color-border, #cbd2dd); }
.dsh-oai-oauth button:disabled { opacity: .55; cursor: default; }
.dsh-oai-oauth label { display: grid; gap: 6px; min-width: 220px; font-size: 13px; font-weight: 600; }
.dsh-oai-oauth select, .dsh-oai-oauth input[type="url"] { min-height: 38px; border: 1px solid var(--color-border, #cbd2dd); border-radius: 8px; padding: 0 10px; color: inherit; background: var(--color-bg, transparent); font: inherit; }
.dsh-oai-oauth input[type="url"] { width: min(420px, 80vw); }
.dsh-oai-oauth-check { display: flex !important; grid-template-columns: none !important; align-items: center; min-width: auto !important; }
.dsh-oai-oauth-error { color: #c23636 !important; }
.dsh-oai-oauth-note { font-size: 13px; }
`

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `request failed (${String(response.status)})`)
  return body
}

function get<T>(path: string): Promise<T> {
  return fetch(`${HTTP_PREFIX}${path}`, { cache: 'no-store' }).then(responseJson<T>)
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return fetch(`${HTTP_PREFIX}${path}`, {
    method: 'POST',
    headers: {
      [MUTATION_HEADER]: '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  }).then(responseJson<T>)
}

function statusText(status: Status | undefined): string {
  switch (status?.state) {
    case 'connected': return status.expired === true ? '已登录，token 将在下次请求时自动刷新' : '已连接 ChatGPT Plus/Pro'
    case 'logging-in': return '等待浏览器授权'
    case 'error': return '登录失败'
    case 'disconnected': return '尚未登录'
    default: return '正在读取状态'
  }
}

/** Standalone settings section for subscription OAuth and its default model. */
function OpenAIOAuthSettings(): ReactNode {
  const [status, setStatus] = useState<Status>()
  const [catalog, setCatalog] = useState<ModelsPayload>()
  const [model, setModel] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [authUrl, setAuthUrl] = useState<string>()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('http://127.0.0.1:7890')
  const [proxyLoaded, setProxyLoaded] = useState(false)

  const refresh = useCallback(async (): Promise<Status> => {
    const [statusBody, modelsBody, proxyBody] = await Promise.all([
      get<{ status: Status }>('/status'),
      get<ModelsPayload>('/models'),
      get<{ proxy: ProxySettings }>('/proxy'),
    ])
    setStatus(statusBody.status)
    setCatalog(modelsBody)
    const selectedModel = modelsBody.selection?.model ?? modelsBody.models[0]?.id ?? ''
    setModel(current => modelsBody.models.some(row => row.id === current) ? current : selectedModel)
    setReasoning(current => current || (modelsBody.selection?.reasoningEffort ?? ''))
    if (!proxyLoaded) {
      setProxyEnabled(proxyBody.proxy.enabled)
      setProxyUrl(proxyBody.proxy.url)
      setProxyLoaded(true)
    }
    return statusBody.status
  }, [proxyLoaded])

  useEffect(() => {
    void refresh().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [refresh])

  useEffect(() => {
    if (status?.state !== 'logging-in') return
    const timer = window.setInterval(() => {
      void refresh().then(next => {
        if (next.state === 'connected') setAuthUrl(undefined)
      }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
    }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [refresh, status?.state])

  const login = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const popup = window.open('about:blank', 'dsh-oai-oauth', 'popup,width=720,height=760')
    try {
      await post('/proxy', { enabled: proxyEnabled, url: proxyUrl })
      const result = await post<{ url: string }>('/login')
      setAuthUrl(result.url)
      setStatus({ state: 'logging-in' })
      if (popup !== null) popup.location.href = result.url
    } catch (reason) {
      popup?.close()
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const saveProxy = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const body = await post<{ proxy: ProxySettings }>('/proxy', { enabled: proxyEnabled, url: proxyUrl })
      setProxyEnabled(body.proxy.enabled)
      setProxyUrl(body.proxy.url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await post('/logout')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const saveDefault = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await post('/default-model', { model, ...reasoning.length === 0 ? {} : { reasoningEffort: reasoning } })
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const refreshCatalog = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await post('/models/refresh')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const selected = catalog?.models.find(row => row.id === model)
  return (
    <div className="dsh-oai-oauth">
      <h2>OpenAI OAuth</h2>
      <p>使用 ChatGPT Plus/Pro 订阅登录 GPT/Codex 模型。它只连接 ChatGPT Codex backend，不替代公共 OpenAI API 的 API Key。</p>

      <section className="dsh-oai-oauth-card">
        <h2>插件代理</h2>
        <p>只代理本插件的 OAuth 登录、token 刷新和模型请求，不影响 DSH Web、其他插件或系统网络。</p>
        <div className="dsh-oai-oauth-row">
          <label className="dsh-oai-oauth-check">
            <input type="checkbox" checked={proxyEnabled} onChange={event => { setProxyEnabled(event.target.checked) }} />
            启用代理
          </label>
          <label>
            代理地址
            <input type="url" value={proxyUrl} placeholder="http://127.0.0.1:7890" disabled={!proxyEnabled}
              onChange={event => { setProxyUrl(event.target.value) }} />
          </label>
          <button className="secondary" disabled={busy || (proxyEnabled && proxyUrl.length === 0)} onClick={() => { void saveProxy() }}>保存代理设置</button>
        </div>
        <p className="dsh-oai-oauth-note">浏览器打开的登录网页仍使用浏览器自己的网络；授权码交换及后续 API 请求使用这里的代理。</p>
      </section>

      <section className="dsh-oai-oauth-card">
        <div className="dsh-oai-oauth-row">
          <span className="dsh-oai-oauth-status">
            <span className={`dsh-oai-oauth-dot ${status?.state ?? ''}`} />
            {statusText(status)}
          </span>
          {status?.state === 'connected'
            ? <button className="secondary" disabled={busy} onClick={() => { void logout() }}>断开连接</button>
            : <button disabled={busy || status?.state === 'logging-in'} onClick={() => { void login() }}>使用浏览器登录</button>}
          <button className="secondary" disabled={busy} onClick={() => { void refresh() }}>刷新状态</button>
        </div>
        {authUrl !== undefined && <p className="dsh-oai-oauth-note">浏览器没有自动打开？<a href={authUrl} target="_blank" rel="noreferrer">点击继续授权</a></p>}
        {status?.error !== undefined && <p className="dsh-oai-oauth-error">{status.error}</p>}
      </section>

      <section className="dsh-oai-oauth-card">
        <h2>默认模型</h2>
        <p>登录后目录来自当前 ChatGPT 账号；读取失败时使用插件随附目录。这里的选择会保存为 DSH 新会话的默认模型，现有会话仍保留自己的模型。</p>
        <p className="dsh-oai-oauth-note">当前已加载 {catalog?.models.length ?? 0} 个模型。下拉框闭合时只显示当前选中的一个模型。</p>
        <div className="dsh-oai-oauth-row">
          <label>
            模型
            <select value={model} onChange={event => { setModel(event.target.value); setReasoning('') }}>
              {(catalog?.models ?? []).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <label>
            推理强度
            <select value={reasoning} onChange={event => { setReasoning(event.target.value) }}>
              <option value="">模型默认</option>
              {(selected?.reasoningEfforts ?? []).map(level => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          <button disabled={busy || model.length === 0} onClick={() => { void saveDefault() }}>设为默认模型</button>
          <button className="secondary" disabled={busy || status?.state !== 'connected'} onClick={() => { void refreshCatalog() }}>刷新模型目录</button>
        </div>
      </section>

      {error !== undefined && <p className="dsh-oai-oauth-error">{error}</p>}
    </div>
  )
}

export const inject = ['slots']

/** Register the page and its plugin-owned style element. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-oai-oauth'
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-oai-oauth: settings styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-oauth',
    order: 15,
    label: 'OpenAI OAuth',
  }, OpenAIOAuthSettings))
}
