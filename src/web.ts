/** Same-origin settings API for the browser half; responses never contain credentials. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { HTTP_PREFIX, MUTATION_HEADER, PROVIDER_ID } from './constants.ts'
import type {} from './oauth-service.ts'
import type { ProxySettings } from './proxy.ts'

export const inject = ['openaiOAuth', 'openaiProxy', 'webServer', 'agentDefaultModel', 'llm']

interface DefaultModelRequest {
  model: string
  reasoningEffort?: string
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
  })
  res.end(encoded)
}

/** Visible same-origin page used while the settings page prepares the OAuth URL. */
export function loginPendingPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenAI OAuth</title></head>
<body style="font-family:system-ui;padding:40px;line-height:1.55">
  <h1>正在准备 OpenAI 登录</h1>
  <p id="status">请稍候，不要关闭这个窗口。</p>
</body>
</html>`
}

/** Accept only the fixed OpenAI authorization endpoint as a redirect destination. */
export function loginRedirectTarget(requestUrl: string | undefined): string | undefined {
  const raw = new URL(requestUrl ?? '/', 'http://localhost').searchParams.get('target')
  if (raw === null) return undefined
  const target = new URL(raw)
  if (target.origin !== 'https://auth.openai.com' || target.pathname !== '/oauth/authorize') {
    throw new Error('invalid OAuth destination')
  }
  return target.href
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
    'content-length': 0,
  })
  res.end()
}

function method(req: IncomingMessage, res: ServerResponse, expected: 'GET' | 'POST'): boolean {
  if (req.method === expected) return true
  res.setHeader('allow', expected)
  json(res, 405, { error: `method must be ${expected}` })
  return false
}

function mutationAllowed(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers[MUTATION_HEADER] === '1') return true
  json(res, 403, { error: `missing ${MUTATION_HEADER} request header` })
  return false
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16_384) throw new Error('request body exceeds 16 KiB')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function defaultRequest(value: unknown): DefaultModelRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request must be an object')
  const row = value as Record<string, unknown>
  if (typeof row['model'] !== 'string' || row['model'].length === 0) throw new Error('model must be a non-empty string')
  if (row['reasoningEffort'] !== undefined
    && (typeof row['reasoningEffort'] !== 'string' || row['reasoningEffort'].length === 0)) {
    throw new Error('reasoningEffort must be a non-empty string')
  }
  return {
    model: row['model'],
    ...row['reasoningEffort'] === undefined ? {} : { reasoningEffort: row['reasoningEffort'] as string },
  }
}

function proxyRequest(value: unknown): ProxySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request must be an object')
  const row = value as Record<string, unknown>
  if (typeof row['enabled'] !== 'boolean') throw new Error('enabled must be a boolean')
  if (typeof row['url'] !== 'string') throw new Error('url must be a string')
  return { enabled: row['enabled'], url: row['url'].trim() }
}

/** Register settings endpoints after both the OAuth service and Web host exist. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const routes = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/login-pending`,
      handler: async (req, res) => {
        if (!method(req, res, 'GET')) return
        try {
          const target = loginRedirectTarget(req.url)
          if (target !== undefined) {
            redirect(res, target)
            return
          }
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        html(res, loginPendingPage())
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/proxy`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          json(res, 200, { proxy: ctx.openaiProxy.settings() })
          return
        }
        if (!method(req, res, 'POST') || !mutationAllowed(req, res)) return
        try {
          await ctx.openaiProxy.save(proxyRequest(await readJson(req)))
          json(res, 200, { proxy: ctx.openaiProxy.settings() })
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/status`,
      handler: async (req, res) => {
        if (!method(req, res, 'GET')) return
        json(res, 200, { status: await ctx.openaiOAuth.status() })
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/models`,
      handler: async (req, res) => {
        if (!method(req, res, 'GET')) return
        const status = await ctx.openaiOAuth.status()
        if (status.state === 'connected') await ctx.openaiOAuth.refreshCatalog().catch(() => {})
        const selected = ctx.agentDefaultModel.currentSelection()
        const models = await ctx.llm.listModels(PROVIDER_ID)
        const detailed = await Promise.all(models.map(async model => {
          const resolved = await ctx.llm.resolveModelInfo(PROVIDER_ID, model.id)
          return {
            id: model.id,
            name: model.name,
            reasoningEfforts: resolved.reasoning?.efforts.map(effort => String(effort.id)) ?? [],
          }
        }))
        json(res, 200, {
          models: detailed,
          selection: selected.provider === PROVIDER_ID
            ? { model: selected.model, ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(selected.reasoningEffort) } }
            : undefined,
        })
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/models/refresh`,
      handler: async (req, res) => {
        if (!method(req, res, 'POST') || !mutationAllowed(req, res)) return
        try {
          await ctx.openaiOAuth.refreshCatalog(true)
          json(res, 200, { ok: true })
        } catch (error) {
          json(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/login`,
      handler: async (req, res) => {
        if (!method(req, res, 'POST') || !mutationAllowed(req, res)) return
        try {
          json(res, 200, { url: await ctx.openaiOAuth.startBrowserLogin() })
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/logout`,
      handler: async (req, res) => {
        if (!method(req, res, 'POST') || !mutationAllowed(req, res)) return
        await ctx.openaiOAuth.logout()
        json(res, 200, { ok: true })
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${HTTP_PREFIX}/default-model`,
      handler: async (req, res) => {
        if (!method(req, res, 'POST') || !mutationAllowed(req, res)) return
        try {
          const next = defaultRequest(await readJson(req))
          const model = await ctx.llm.resolveModelInfo(PROVIDER_ID, next.model)
          if (next.reasoningEffort !== undefined
            && !model.reasoning?.efforts.some(effort => String(effort.id) === next.reasoningEffort)) {
            throw new Error(`model ${JSON.stringify(next.model)} does not support reasoning effort ${JSON.stringify(next.reasoningEffort)}`)
          }
          await ctx.agentDefaultModel.saveSelection({
            provider: PROVIDER_ID,
            model: next.model,
            ...next.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(next.reasoningEffort) },
          })
          json(res, 200, { ok: true })
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ]
    return () => { for (const dispose of routes) dispose() }
  }, 'dsh-oai-oauth: settings HTTP routes')
}
