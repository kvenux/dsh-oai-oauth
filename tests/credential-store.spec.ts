import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { CREDENTIAL_REF_NAME, PROVIDER_ID } from '../src/constants.ts'
import { DshOAuthCredentialStore, parseStoredCredential } from '../src/credential-store.ts'

class MemoryCredentials extends CredentialProvider {
  value: string | undefined

  constructor(ctx: Context) {
    super(ctx)
  }

  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'memory' })
  }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.value !== undefined, source: 'memory', writable: true })
  }

  set(_ref: CredentialRef, value: string): Promise<void> {
    this.value = value
    return Promise.resolve()
  }

  unset(_ref: CredentialRef): Promise<void> {
    this.value = undefined
    return Promise.resolve()
  }
}

function oauth(access: string, refresh = 'refresh') {
  return { type: 'oauth' as const, access, refresh, expires: Date.now() + 60_000 }
}

describe('DshOAuthCredentialStore', () => {
  it('rejects malformed durable data before it reaches request auth', () => {
    expect(() => parseStoredCredential('{')).toThrow(`${CREDENTIAL_REF_NAME} does not contain valid JSON`)
    expect(() => parseStoredCredential(JSON.stringify({ type: 'oauth' }))).toThrow('invalid OAuth credential')
  })

  it('serializes token rotation and persists the newest credential', async () => {
    const ctx = new Context()
    const credentials = new MemoryCredentials(ctx)
    const store = new DshOAuthCredentialStore(credentials)
    await store.modify(PROVIDER_ID, async () => oauth('first'))

    const seen: string[] = []
    const first = store.modify(PROVIDER_ID, async current => {
      seen.push(current?.type === 'oauth' ? current.access : 'missing')
      await Promise.resolve()
      return oauth('second')
    })
    const second = store.modify(PROVIDER_ID, async current => {
      seen.push(current?.type === 'oauth' ? current.access : 'missing')
      return oauth('third')
    })
    await Promise.all([first, second])

    expect(seen).toEqual(['first', 'second'])
    await expect(store.read(PROVIDER_ID)).resolves.toMatchObject({ type: 'oauth', access: 'third' })
    await expect(store.list()).resolves.toEqual([{ providerId: PROVIDER_ID, type: 'oauth' }])
  })

  it('deletes only the owned provider credential', async () => {
    const ctx = new Context()
    const credentials = new MemoryCredentials(ctx)
    const store = new DshOAuthCredentialStore(credentials)
    await store.modify(PROVIDER_ID, async () => oauth('token'))
    await store.delete(PROVIDER_ID)
    await expect(store.read(PROVIDER_ID)).resolves.toBeUndefined()
  })
})
