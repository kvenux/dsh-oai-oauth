import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CredentialProvider, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import DshOpenAIOAuthPlugin, { PROVIDER_ID } from '../src/index.ts'
import { loginPendingPage } from '../src/web.ts'

class EmptyCredentials extends CredentialProvider {
  constructor(ctx: Context) { super(ctx) }
  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }
  describe(_ref: CredentialRef): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: true }) }
  set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.resolve() }
  unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }
}

describe('dsh-oai-oauth plugin', () => {
  it('serves a visible same-origin bridge for browser OAuth navigation', () => {
    const page = loginPendingPage()
    expect(page).toContain('正在准备 OpenAI 登录')
    expect(page).toContain("target.hostname !== 'auth.openai.com'")
    expect(page).toContain('location.replace(target.href)')
  })

  it('registers the OAuth provider and current pi-ai model catalog without logging in', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(EmptyCredentials)
    await ctx.plugin(DshOpenAIOAuthPlugin)

    expect(ctx.llm.listProviders()).toContainEqual({ id: PROVIDER_ID, name: 'OpenAI (ChatGPT Plus/Pro)' })
    const models = await ctx.llm.listModels(PROVIDER_ID)
    expect(models.map(model => model.id)).toEqual([
      'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5',
      'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
    ])
    expect((await ctx.llm.resolveModelInfo(PROVIDER_ID, 'gpt-5.5')).reasoning?.efforts.map(effort => String(effort.id)))
      .toEqual(['low', 'medium', 'high', 'xhigh'])
    expect((await ctx.llm.resolveModelInfo(PROVIDER_ID, 'gpt-5.6-sol')).reasoning?.efforts.map(effort => String(effort.id)))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(await ctx.openaiOAuth.status()).toEqual({ state: 'disconnected' })
    expect(ctx.openaiProxy.settings()).toEqual({ enabled: false, url: 'http://127.0.0.1:7890' })

  })
})
