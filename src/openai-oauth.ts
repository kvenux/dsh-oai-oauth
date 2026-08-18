/** OpenAI Codex browser OAuth with an injectable, plugin-scoped HTTP transport. */

import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AuthInteraction, FetchFunction, OAuthCredential } from '@earendil-works/pi-ai'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPE = 'openid profile email offline_access'
const JWT_CLAIM = 'https://api.openai.com/auth'

interface TokenResponse { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString('base64url')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: Buffer.from(digest).toString('base64url') }
}

function accountId(access: string): string {
  try {
    const payload = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const claim = payload[JWT_CLAIM]
    if (typeof claim === 'object' && claim !== null) {
      const value = (claim as Record<string, unknown>)['chatgpt_account_id']
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    // Invalid token payloads are reported through the stable error below.
  }
  throw new Error('Failed to extract accountId from OpenAI OAuth token')
}

async function tokenCredential(response: Response, operation: string): Promise<OAuthCredential> {
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex token ${operation} failed (${String(response.status)}): ${detail || response.statusText}`)
  }
  const body = await response.json() as TokenResponse
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error(`OpenAI Codex token ${operation} response is missing required fields`)
  }
  return {
    type: 'oauth', access: body.access_token, refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000, accountId: accountId(body.access_token),
  }
}

function callbackPage(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>OpenAI OAuth</title><body style="font-family:system-ui;padding:40px"><h1>${ok ? '登录完成' : '登录失败'}</h1><p>${message}</p></body>`
}

interface CallbackServer { server: Server; code: Promise<string> }

function callbackServer(state: string): Promise<CallbackServer> {
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(callbackPage(false, '回调地址不正确。'))
      return
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(callbackPage(false, 'OAuth state 不匹配。'))
      rejectCode(new Error('OpenAI OAuth state mismatch'))
      return
    }
    const value = url.searchParams.get('code')
    if (value === null || value.length === 0) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(callbackPage(false, '没有收到授权码。'))
      rejectCode(new Error('OpenAI OAuth callback is missing authorization code'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(callbackPage(true, '可以关闭这个窗口，返回 DSH。'))
    resolveCode(value)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(1455, '127.0.0.1', () => resolve({ server, code }))
  })
}

function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => reject(new DOMException('OpenAI OAuth login cancelled', 'AbortError'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

/** Create the pi-ai OAuth method while resolving the transport at each network operation. */
export function createOpenAICodexOAuth(resolveFetch: () => FetchFunction | undefined) {
  const request: FetchFunction = (input, init) => (resolveFetch() ?? globalThis.fetch)(input, init)
  return {
    name: 'OpenAI (ChatGPT Plus/Pro)',
    isSubscription: true,
    async login(interaction: AuthInteraction & { signal: AbortSignal }): Promise<OAuthCredential> {
      const { verifier, challenge } = await pkce()
      const state = randomBytes(16).toString('hex')
      const url = new URL(AUTHORIZE_URL)
      for (const [key, value] of Object.entries({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
        code_challenge: challenge, code_challenge_method: 'S256', state,
        id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'pi',
      })) url.searchParams.set(key, value)
      const callback = await callbackServer(state)
      interaction.notify({ type: 'auth_url', url: url.toString(), instructions: 'Complete login in the browser.' })
      try {
        const code = await Promise.race([callback.code, abortRace(interaction.signal)])
        const response = await request(TOKEN_URL, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: REDIRECT_URI,
          }), signal: interaction.signal,
        })
        return tokenCredential(response, 'exchange')
      } finally {
        callback.server.close()
      }
    },
    async refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
      let response: Response
      try {
        response = await request(TOKEN_URL, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: CLIENT_ID }), signal,
        })
      } catch (error) {
        throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`)
      }
      return tokenCredential(response, 'refresh')
    },
    toAuth(credential: OAuthCredential): Promise<{ apiKey: string }> {
      return Promise.resolve({ apiKey: credential.access })
    },
  }
}
