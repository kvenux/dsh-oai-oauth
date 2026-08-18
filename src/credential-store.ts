/** DSH credential-reference storage adapted to pi-ai's serialized OAuth store. */

import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai'
import { CREDENTIAL_REF_NAME, PROVIDER_ID } from './constants.ts'

const REF = credentialRef(CREDENTIAL_REF_NAME)

function throwIfAborted(options?: AuthOperationOptions): void {
  options?.signal?.throwIfAborted()
}

/** Validate the durable JSON before it reaches OAuth refresh or request headers. */
export function parseStoredCredential(raw: string): OAuthCredential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${CREDENTIAL_REF_NAME} does not contain valid JSON`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${CREDENTIAL_REF_NAME} must contain an OAuth credential object`)
  }
  const record = value as Record<string, unknown>
  if (record['type'] !== 'oauth'
    || typeof record['access'] !== 'string' || record['access'].length === 0
    || typeof record['refresh'] !== 'string' || record['refresh'].length === 0
    || typeof record['expires'] !== 'number' || !Number.isFinite(record['expires'])) {
    throw new Error(`${CREDENTIAL_REF_NAME} contains an invalid OAuth credential`)
  }
  return record as OAuthCredential
}

/**
 * Persist one pi-ai credential per provider through DSH's managed credential file.
 * The promise chain serializes refresh/login/logout within this DSH process.
 */
export class DshOAuthCredentialStore implements CredentialStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly credentials: CredentialProvider) {}

  /** Read the OpenAI OAuth document without caching it across operations. */
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    throwIfAborted(options)
    if (providerId !== PROVIDER_ID) return undefined
    const resolved = await this.credentials.resolve(REF)
    throwIfAborted(options)
    return resolved === undefined ? undefined : parseStoredCredential(resolved.value)
  }

  /** Return non-secret configured metadata. */
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options)
    const info = await this.credentials.describe(REF)
    throwIfAborted(options)
    return info.configured ? [{ providerId: PROVIDER_ID, type: 'oauth' }] : []
  }

  /** Serialize a read-modify-write so a rotated refresh token is not overwritten in-process. */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== PROVIDER_ID) throw new Error(`unsupported OAuth provider ${JSON.stringify(providerId)}`)
    let result: Credential | undefined
    const operation = this.tail.then(async () => {
      throwIfAborted(options)
      const current = await this.read(providerId, options)
      const next = await fn(current)
      throwIfAborted(options)
      if (next !== undefined) {
        if (next.type !== 'oauth') throw new Error('OpenAI Codex requires an OAuth credential')
        await this.credentials.set(REF, JSON.stringify(next))
      }
      result = next ?? current
    })
    this.tail = operation.catch(() => {})
    await operation
    return result
  }

  /** Remove the persisted OAuth credential after prior mutations settle. */
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (providerId !== PROVIDER_ID) return
    const operation = this.tail.then(async () => {
      throwIfAborted(options)
      await this.credentials.unset(REF)
      throwIfAborted(options)
    })
    this.tail = operation.catch(() => {})
    await operation
  }
}
