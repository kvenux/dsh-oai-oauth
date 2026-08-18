import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AuthInteraction, Models } from '@earendil-works/pi-ai'
import type { DshOAuthCredentialStore } from '../src/credential-store.ts'
import { OpenAIOAuthService } from '../src/oauth-service.ts'

describe('OpenAIOAuthService', () => {
  it('returns to disconnected after clearing an active login', async () => {
    const models = {
      login: (_provider: string, _method: string, interaction: AuthInteraction): Promise<void> => {
        interaction.notify({
          type: 'auth_url',
          url: 'https://auth.openai.com/oauth/authorize?state=test',
        })
        return new Promise((_resolve, reject) => {
          interaction.signal?.addEventListener('abort', () => {
            reject(new Error(String(interaction.signal?.reason)))
          }, { once: true })
        })
      },
      logout: vi.fn(() => Promise.resolve()),
    } as unknown as Models
    const store = {
      read: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as DshOAuthCredentialStore
    const service = new OpenAIOAuthService(new Context(), models, store)

    await expect(service.startBrowserLogin()).resolves.toContain('https://auth.openai.com/oauth/authorize')
    await expect(service.status()).resolves.toEqual({ state: 'logging-in' })

    await service.logout()
    await Promise.resolve()

    await expect(service.status()).resolves.toEqual({ state: 'disconnected' })
    expect(models.logout).toHaveBeenCalledWith('openai-codex')
  })
})
