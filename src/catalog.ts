/** ChatGPT Codex model catalog layered over pi-ai's offline baseline. */

import {
  createProvider,
  type FetchFunction,
  type Model,
  type OAuthCredential,
  type Provider,
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { createOpenAICodexOAuth } from './openai-oauth.ts'

const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.147.0'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type CodexModel = Model<'openai-codex-responses'>

interface RemoteEffort { effort?: unknown }
interface RemoteModel {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  context_window?: unknown
  supported_reasoning_levels?: unknown
  input_modalities?: unknown
}
interface RemoteCatalog { models?: unknown }

function effortsOf(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.flatMap((entry): string[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const effort = (entry as RemoteEffort).effort
    return typeof effort === 'string' ? [effort] : []
  }))
}

function withEfforts(model: CodexModel, efforts: ReadonlySet<string>): CodexModel {
  return {
    ...model,
    reasoning: efforts.size > 0,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      ...Object.fromEntries(EFFORTS.map(effort => [effort, efforts.has(effort) ? effort : null])),
    },
  }
}

function baselineModels(provider: Provider<'openai-codex-responses'>): CodexModel[] {
  return provider.getModels().map(model => {
    const supported = new Set<string>(['low', 'medium', 'high'])
    if (model.thinkingLevelMap?.xhigh !== undefined) supported.add('xhigh')
    if (model.thinkingLevelMap?.max !== undefined) supported.add('max')
    return withEfforts(model, supported)
  })
}

function templateFor(id: string, baseline: readonly CodexModel[]): CodexModel | undefined {
  return baseline.find(model => model.id === id)
    ?? baseline.find(model => id.startsWith('gpt-5.6') && model.id === 'gpt-5.6-sol')
    ?? baseline.find(model => model.id === 'gpt-5.5')
}

function parseRemoteCatalog(value: unknown, baseline: readonly CodexModel[]): CodexModel[] {
  if (typeof value !== 'object' || value === null) throw new Error('OpenAI Codex model catalog must be an object')
  const rows = (value as RemoteCatalog).models
  if (!Array.isArray(rows)) throw new Error('OpenAI Codex model catalog is missing models')
  const models: CodexModel[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const remote = row as RemoteModel
    if (typeof remote.slug !== 'string' || remote.slug.length === 0 || remote.visibility === 'hide') continue
    const template = templateFor(remote.slug, baseline)
    if (template === undefined) continue
    const efforts = effortsOf(remote.supported_reasoning_levels)
    const input = Array.isArray(remote.input_modalities) && remote.input_modalities.includes('image')
      ? ['text', 'image'] as const
      : template.input
    models.push(withEfforts({
      ...template,
      id: remote.slug,
      name: typeof remote.display_name === 'string' && remote.display_name.length > 0 ? remote.display_name : remote.slug,
      input: [...input],
      ...typeof remote.context_window === 'number' && remote.context_window > 0
        ? { contextWindow: remote.context_window }
        : {},
    }, efforts))
  }
  if (models.length === 0) throw new Error('OpenAI Codex model catalog contained no usable models')
  return models
}

/** Create a Codex provider whose baseline works offline and whose account catalog refreshes after login. */
export function createCatalogProvider(resolveFetch: () => FetchFunction | undefined): Provider<'openai-codex-responses'> {
  const upstream = openaiCodexProvider()
  const baseline = baselineModels(upstream)
  let cached: readonly CodexModel[] | undefined
  let cachedAt = 0
  return createProvider<'openai-codex-responses'>({
    id: upstream.id,
    name: upstream.name,
    baseUrl: upstream.baseUrl ?? 'https://chatgpt.com/backend-api',
    auth: { oauth: createOpenAICodexOAuth(resolveFetch) },
    models: baseline,
    fetchModels: async context => {
      if (!context.force && cached !== undefined && Date.now() - cachedAt < 5 * 60_000) return cached
      const credential = context.credential as OAuthCredential | undefined
      if (credential?.type !== 'oauth') return []
      const accountId = typeof credential['accountId'] === 'string' ? credential['accountId'] : undefined
      const response = await (resolveFetch() ?? globalThis.fetch)(MODELS_URL, {
        headers: {
          authorization: `Bearer ${credential.access}`,
          ...(accountId === undefined ? {} : { 'chatgpt-account-id': accountId }),
          accept: 'application/json',
          originator: 'dsh-oai-oauth',
        },
        signal: context.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`OpenAI Codex model catalog failed (${String(response.status)}): ${detail || response.statusText}`)
      }
      cached = parseRemoteCatalog(await response.json(), baseline)
      cachedAt = Date.now()
      return cached
    },
    api: {
      stream: (model, requestContext, options) => upstream.stream(model as CodexModel, requestContext, options),
      streamSimple: (model, requestContext, options) => upstream.streamSimple(model as CodexModel, requestContext, options),
    },
  })
}

export const catalogInternals = { parseRemoteCatalog, baselineModels }
