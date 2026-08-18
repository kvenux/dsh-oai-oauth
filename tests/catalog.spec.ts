import { describe, expect, it } from 'vitest'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { catalogInternals } from '../src/catalog.ts'

describe('OpenAI Codex model catalog', () => {
  it('ships the requested GPT 5.4, 5.5, and 5.6 fallback models', () => {
    const models = catalogInternals.baselineModels(openaiCodexProvider())
    expect(models.map(model => model.id)).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])
  })

  it('maps account-visible models and their server-provided reasoning efforts', () => {
    const baseline = catalogInternals.baselineModels(openaiCodexProvider())
    const models = catalogInternals.parseRemoteCatalog({
      models: [
        {
          slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', context_window: 272000,
          input_modalities: ['text', 'image'],
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
        },
        {
          slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', context_window: 272000,
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort })),
        },
        { slug: 'codex-auto-review', display_name: 'hidden', visibility: 'hide' },
      ],
    }, baseline)

    expect(models.map(model => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5'])
    expect(models[0]?.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
    expect(models[1]?.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null })
  })
})
