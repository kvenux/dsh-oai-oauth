/** ChatGPT Plus/Pro OAuth-backed OpenAI Codex provider for DSH. */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createModels } from '@earendil-works/pi-ai'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { OpenAICodexAdapter } from './adapter.ts'
import { createCatalogProvider } from './catalog.ts'
import { PROVIDER_ID } from './constants.ts'
import { DshOAuthCredentialStore } from './credential-store.ts'
import { OpenAIOAuthService } from './oauth-service.ts'
import { OpenAIProxyService, ProxySettingsSchema, type ProxySettings } from './proxy.ts'

export { CREDENTIAL_REF_NAME, PROVIDER_ID } from './constants.ts'
export { DshOAuthCredentialStore, parseStoredCredential } from './credential-store.ts'
export { OpenAIOAuthService } from './oauth-service.ts'
export type { LoginState, OAuthStatus } from './oauth-service.ts'
export { PROXY_SETTINGS_NAMESPACE, validateProxySettings } from './proxy.ts'
export type { ProxySettings } from './proxy.ts'

/** Plugin composition settings. */
export interface Config extends ProxySettings {}

/** Root plugin: one pi-ai collection shared by login, refresh, catalog, and requests. */
export default class DshOpenAIOAuthPlugin extends Service {
  static inject = ['llm', 'credentials']
  static Config: z<Config> = ProxySettingsSchema

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dshOpenAIOAuth')
    const proxy = new OpenAIProxyService(ctx, config)
    const store = new DshOAuthCredentialStore(ctx.credentials)
    const models = createModels({ credentials: store })
    models.setProvider(createCatalogProvider(() => proxy.fetch()))
    new OpenAIOAuthService(ctx, models, store)
    const adapter = new OpenAICodexAdapter(models, () => ctx.get('attachments'), () => proxy.fetch())
    ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  }
}
