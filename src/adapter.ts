/** OpenAI Codex pi-ai provider adapted to DSH's model and streaming vocabulary. */

import {
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ReplayEnvelope,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  getSupportedThinkingLevels,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context as PiContext,
  type FetchFunction,
  type ImageContent,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type Message as PiMessage,
  type TextContent,
  type ThinkingLevel,
  type Tool as PiTool,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai'
import { PROVIDER_ID } from './constants.ts'

interface ReplayResponse {
  kind: 'dsh-oai-oauth'
  version: 1
  api: Api
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  stopReason: AssistantMessage['stopReason']
}

type ReplayBlock =
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string }

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // A malformed historical call remains representable to pi-ai as an empty object.
  }
  return {}
}

function foreignAssistant(message: Message): AssistantMessage {
  const source = message.source.kind === 'model' ? message.source : undefined
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      }); break
      case 'image': throw new LlmError('assistant image history is unsupported by pi-ai', 'UNSUPPORTED_CONTENT')
      default: break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: source?.provider ?? 'dsh-foreign',
    model: source?.model ?? 'dsh-foreign',
    usage: emptyUsage(),
    stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function replayResponse(value: unknown): ReplayResponse | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row['kind'] !== 'dsh-oai-oauth' || row['version'] !== 1) return undefined
  if (typeof row['api'] !== 'string' || typeof row['provider'] !== 'string' || typeof row['model'] !== 'string') return undefined
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(row['stopReason']))) return undefined
  return row as unknown as ReplayResponse
}

function replayBlock(value: unknown): ReplayBlock | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!['text', 'reasoning', 'tool-call'].includes(String(row['type']))) return undefined
  return row as ReplayBlock
}

function toPiAssistant(message: Message): AssistantMessage {
  if (message.source.kind !== 'model' || message.source.replayState === undefined) return foreignAssistant(message)
  const envelope = message.source.replayState as ReplayEnvelope
  const response = replayResponse(envelope.response)
  const blocks = envelope.blocks?.map(replayBlock)
  if (response === undefined || blocks === undefined || blocks.some(block => block === undefined)
    || blocks.length !== message.content.length
    || response.provider !== message.source.provider || response.model !== message.source.model) {
    return foreignAssistant(message)
  }
  const content: AssistantMessage['content'] = []
  for (const [index, block] of message.content.entries()) {
    const replay = blocks[index]
    if (replay === undefined || replay.type !== block.type) return foreignAssistant(message)
    switch (block.type) {
      case 'text': content.push({
        type: 'text', text: block.text,
        ...replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {},
      }); break
      case 'reasoning': content.push({
        type: 'thinking', thinking: block.text,
        ...replay.type === 'reasoning' && replay.thinkingSignature !== undefined
          ? { thinkingSignature: replay.thinkingSignature }
          : {},
        ...replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {},
      }); break
      case 'tool-call': content.push({
        type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments),
        ...replay.type === 'tool-call' && replay.thoughtSignature !== undefined
          ? { thoughtSignature: replay.thoughtSignature }
          : {},
      }); break
      default: return foreignAssistant(message)
    }
  }
  return {
    role: 'assistant',
    content,
    api: response.api,
    provider: response.provider,
    model: response.model,
    ...response.responseModel === undefined ? {} : { responseModel: response.responseModel },
    ...response.responseId === undefined ? {} : { responseId: response.responseId },
    usage: emptyUsage(),
    stopReason: response.stopReason,
    timestamp: 0,
  }
}

function flattenText(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (attachments === undefined) throw new LlmError('image input requires the DSH attachment service', 'UNSUPPORTED_CONTENT')
        const stored = await attachments.readImage(block.attachment, signal)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'tool-result': {
        const nested = await userContent(block.content, attachments, signal)
        if (typeof nested === 'string') {
          if (nested.length > 0) content.push({ type: 'text', text: nested })
        } else content.push(...nested)
        break
      }
      default: break
    }
  }
  return content.every(block => block.type === 'text')
    ? content.map(block => block.text).join('')
    : content
}

async function toPiContext(options: GenerateOptions, attachments?: AttachmentStore): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = await userContent(regular, attachments, options.signal)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) messages.push({ role: 'user', content, timestamp: 0 })
    for (const result of results) {
      const nested = await userContent(result.content, attachments, options.signal)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof nested === 'string' ? [{ type: 'text', text: nested || '(no output)' }] : nested,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const tools: PiTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    ...options.system === undefined ? {} : { systemPrompt: options.system },
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function usageOf(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

function finishOf(message: AssistantMessage, contextWindow: number): FinishReason {
  if (isContextOverflow(message, contextWindow)) {
    return { kind: 'error', failure: { message: message.errorMessage ?? 'context window exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' } }
  }
  switch (message.stopReason) {
    case 'stop': return message.content.length === 0
      ? { kind: 'error', failure: { message: `model ${JSON.stringify(message.model)} returned no content`, code: 'EMPTY_RESPONSE' } }
      : { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return { kind: 'aborted', failure: { message: message.errorMessage ?? 'request aborted', code: 'ABORTED' } }
    case 'error': return { kind: 'error', failure: { message: message.errorMessage ?? 'OpenAI Codex request failed', code: 'PROVIDER_ERROR' } }
    default: return { kind: 'error', failure: { message: `unknown provider stop reason ${String(message.stopReason)}`, code: 'PROVIDER_ERROR' } }
  }
}

function replayOf(message: AssistantMessage): ReplayEnvelope {
  return {
    response: {
      kind: 'dsh-oai-oauth',
      version: 1,
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...message.responseModel === undefined ? {} : { responseModel: message.responseModel },
      ...message.responseId === undefined ? {} : { responseId: message.responseId },
      stopReason: message.stopReason,
    } satisfies ReplayResponse,
    blocks: message.content.map((block): ReplayBlock => {
      switch (block.type) {
        case 'text': return { type: 'text', ...block.textSignature === undefined ? {} : { textSignature: block.textSignature } }
        case 'thinking': return {
          type: 'reasoning',
          ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === undefined ? {} : { redacted: block.redacted },
        }
        case 'toolCall': return { type: 'tool-call', ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature } }
      }
    }),
  }
}

async function* chunksOf(events: AsyncIterable<AssistantMessageEvent>, contextWindow: number): AsyncGenerator<StreamChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start': break
      case 'text_start': yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }; break
      case 'text_delta': yield { type: 'text-delta', index: event.contentIndex, text: event.delta }; break
      case 'text_end': yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }; break
      case 'thinking_start': yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }; break
      case 'thinking_delta': yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }; break
      case 'thinking_end': yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }; break
      case 'toolcall_start': {
        const block = event.partial.content[event.contentIndex]
        const id = block?.type === 'toolCall' ? block.id : ''
        const name = block?.type === 'toolCall' ? block.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...known?.name === undefined || known.name.length === 0 ? {} : { name: known.name },
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end': yield {
        type: 'block-end',
        index: event.contentIndex,
        block: {
          type: 'tool-call',
          id: CallId(event.toolCall.id),
          name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments),
        },
      }; break
      case 'done':
        yield { type: 'usage', usage: usageOf(event.message.usage) }
        yield { type: 'finish', reason: finishOf(event.message, contextWindow), replayState: replayOf(event.message) }
        return
      case 'error':
        yield { type: 'usage', usage: usageOf(event.error.usage) }
        yield { type: 'finish', reason: finishOf(event.error, contextWindow) }
        return
    }
  }
  throw new LlmError('OpenAI Codex event stream ended without a terminal event', 'STREAM_CLOSED')
}

function modelOf(models: Models, id: string): Model<Api> {
  const model = models.getModel(PROVIDER_ID, id)
  if (model === undefined) throw new LlmError(`OpenAI Codex has no model ${JSON.stringify(id)}`, 'UNKNOWN_MODEL')
  return model
}

/** DSH adapter whose pi-ai collection owns OAuth refresh and Codex Responses dispatch. */
export class OpenAICodexAdapter extends LlmAdapter {
  constructor(
    private readonly models: Models,
    private readonly attachments: () => AttachmentStore | undefined,
    private readonly requestFetch: () => FetchFunction | undefined,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI (ChatGPT Plus/Pro)' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models.getModels(provider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    })))
  }

  override resolveModel(provider: string, modelId: string): Promise<LlmResolvedModelInfo> {
    const model = modelOf(this.models, modelId)
    const levels = model.reasoning ? getSupportedThinkingLevels(model) : []
    return Promise.resolve({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
      context: { contextWindow: model.contextWindow },
      ...levels.length === 0 ? {} : {
        reasoning: {
          efforts: levels.map(level => ({ id: ReasoningEffortId(level), name: level })),
        },
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) throw new LlmError('OpenAI Codex does not support stop sequences', 'UNSUPPORTED_OPTION')
    const model = modelOf(this.models, options.model)
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(`model ${JSON.stringify(model.id)} does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const context = await toPiContext(options, containsImage ? this.attachments() : undefined)
    const supported = getSupportedThinkingLevels(model)
    const requested = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
    if (requested !== undefined && !supported.includes(requested as ModelThinkingLevel)) {
      throw new LlmError(`model ${JSON.stringify(model.id)} does not support reasoning effort ${JSON.stringify(requested)}`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    const reasoning: ThinkingLevel | undefined = requested === undefined || requested === 'off'
      ? undefined
      : requested as ThinkingLevel
    const attribution = attributionHeaders()
    const requestFetch = this.requestFetch()
    const events = this.models.streamSimple(model, context, {
      ...reasoning === undefined ? {} : { reasoning },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      maxRetries: 0,
      ...requestFetch === undefined ? {} : { fetch: requestFetch, transport: 'sse' as const },
      ...options.signal === undefined ? {} : { signal: options.signal },
      transformHeaders: headers => ({ ...headers, ...attribution }),
    })
    yield* chunksOf(events, model.contextWindow)
  }
}
