/** Browser OAuth orchestration and non-secret settings state. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { AuthInteraction, AuthPrompt, Models, OAuthCredential } from '@earendil-works/pi-ai'
import { PROVIDER_ID } from './constants.ts'
import type { DshOAuthCredentialStore } from './credential-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** OpenAI ChatGPT subscription OAuth state owned by this plugin. */
    openaiOAuth: OpenAIOAuthService
  }
}

export type LoginState = 'disconnected' | 'connected' | 'logging-in' | 'error'

/** Token-free status returned to the settings browser. */
export interface OAuthStatus {
  state: LoginState
  expiresAt?: number
  expired?: boolean
  error?: string
}

interface ActiveLogin {
  controller: AbortController
  url?: string
  urlPromise: Promise<string>
}

function abortError(): Error {
  return new DOMException('OAuth prompt completed elsewhere', 'AbortError')
}

function waitForAbort(...signals: Array<AbortSignal | undefined>): Promise<string> {
  return new Promise((_resolve, reject) => {
    const live = signals.filter((signal): signal is AbortSignal => signal !== undefined)
    if (live.some(signal => signal.aborted)) {
      reject(abortError())
      return
    }
    const onAbort = (): void => {
      for (const signal of live) signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    for (const signal of live) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Owns one login attempt and delegates token refresh to pi-ai's Models runtime. */
export class OpenAIOAuthService extends Service {
  private active: ActiveLogin | undefined
  private lastError: string | undefined

  constructor(
    ctx: Context,
    readonly models: Models,
    private readonly store: DshOAuthCredentialStore,
  ) {
    super(ctx, 'openaiOAuth')
    ctx.effect(() => () => {
      this.active?.controller.abort('dsh-oai-oauth unloaded')
      this.active = undefined
    }, 'dsh-oai-oauth: cancel pending browser login on unload')
  }

  /** Read connection state without exposing access, refresh, account, or identity claims. */
  async status(): Promise<OAuthStatus> {
    if (this.active !== undefined) return { state: 'logging-in' }
    const credential = await this.store.read(PROVIDER_ID)
    if (credential?.type === 'oauth') {
      return {
        state: 'connected',
        expiresAt: credential.expires,
        expired: credential.expires <= Date.now(),
      }
    }
    return this.lastError === undefined
      ? { state: 'disconnected' }
      : { state: 'error', error: this.lastError }
  }

  /** Start the PKCE localhost callback flow and return as soon as its browser URL exists. */
  async startBrowserLogin(): Promise<string> {
    if (this.active !== undefined) return this.active.url ?? this.active.urlPromise

    const controller = new AbortController()
    let resolveUrl!: (url: string) => void
    let rejectUrl!: (error: unknown) => void
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve
      rejectUrl = reject
    })
    const active: ActiveLogin = { controller, urlPromise }
    this.active = active
    this.lastError = undefined

    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: (prompt: AuthPrompt): Promise<string> => {
        if (prompt.type === 'select') return Promise.resolve('browser')
        if (prompt.type === 'manual_code') return waitForAbort(controller.signal, prompt.signal)
        return Promise.reject(new Error(`unexpected OpenAI OAuth prompt ${JSON.stringify(prompt.type)}`))
      },
      notify: (event) => {
        if (event.type !== 'auth_url') return
        active.url = event.url
        resolveUrl(event.url)
      },
    }

    void this.models.login(PROVIDER_ID, 'oauth', interaction).then(
      async () => {
        this.lastError = undefined
        await this.refreshCatalog(true).catch(() => {})
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.lastError = message
        rejectUrl(error)
      },
    ).finally(() => {
      if (this.active === active) this.active = undefined
    })

    return urlPromise
  }

  /** Refresh the account-visible Codex model catalog without exposing credentials. */
  async refreshCatalog(force = false): Promise<void> {
    const result = await this.models.refresh({ providers: [PROVIDER_ID], force })
    const error = result.errors.get(PROVIDER_ID)
    if (error !== undefined) throw error
  }

  /** Cancel any pending flow and remove the stored ChatGPT OAuth credential. */
  async logout(): Promise<void> {
    this.active?.controller.abort('OpenAI OAuth disconnected')
    this.active = undefined
    this.lastError = undefined
    await this.models.logout(PROVIDER_ID)
  }

  /** Read the stored OAuth credential for test and lifecycle diagnostics. */
  readCredential(): Promise<OAuthCredential | undefined> {
    return this.store.read(PROVIDER_ID) as Promise<OAuthCredential | undefined>
  }
}
