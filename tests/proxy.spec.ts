import { createServer } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FetchFunction, OAuthCredential } from '@earendil-works/pi-ai'
import { createOpenAICodexOAuth } from '../src/openai-oauth.ts'
import { OpenAIProxyService, validateProxySettings } from '../src/proxy.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('plugin-scoped proxy transport', () => {
  it('routes its fetch through the configured proxy without replacing global fetch', async () => {
    const seen: string[] = []
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('proxied')
    })
    await new Promise<void>((resolve, reject) => {
      target.once('error', reject)
      target.listen(0, '127.0.0.1', resolve)
    })
    const targetAddress = target.address()
    if (targetAddress === null || typeof targetAddress === 'string') throw new Error('test target did not bind a TCP port')
    const server = createServer()
    server.on('connect', (req, client, head) => {
      seen.push(req.url ?? '')
      const upstream = connect(targetAddress.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test proxy did not bind a TCP port')

    const ctx = new Context()
    contexts.push(ctx)
    const originalFetch = globalThis.fetch
    const proxy = new OpenAIProxyService(ctx, { enabled: true, url: `http://127.0.0.1:${String(address.port)}` })
    const response = await proxy.fetch()?.(`http://127.0.0.1:${String(targetAddress.port)}/request`)

    expect(await response?.text()).toBe('proxied')
    expect(seen).toEqual([`127.0.0.1:${String(targetAddress.port)}`])
    expect(globalThis.fetch).toBe(originalFetch)
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    target.closeAllConnections()
    await new Promise<void>(resolve => target.close(() => resolve()))
  })

  it('rejects unsupported and credential-bearing proxy URLs', () => {
    expect(() => validateProxySettings({ enabled: true, url: 'socks5://127.0.0.1:7890' })).toThrow(/http/)
    expect(() => validateProxySettings({ enabled: true, url: 'http://user:secret@127.0.0.1:7890' })).toThrow(/账号密码/)
    expect(() => validateProxySettings({ enabled: false, url: '' })).not.toThrow()
  })

  it('uses the injected fetch when refreshing an OAuth token', async () => {
    const payload = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
    })).toString('base64url')
    const access = `header.${payload}.signature`
    const fetch = vi.fn<FetchFunction>().mockResolvedValue(new Response(JSON.stringify({
      access_token: access,
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }), { status: 200 }))
    const oauth = createOpenAICodexOAuth(() => fetch)
    const current: OAuthCredential = { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 0 }

    const next = await oauth.refresh(current, new AbortController().signal)

    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://auth.openai.com/oauth/token')
    expect(next).toMatchObject({ access, refresh: 'new-refresh', accountId: 'account-1' })
  })
})
