/** pi-ai's provider route for ChatGPT subscription-backed Codex requests. */
export const PROVIDER_ID = 'openai-codex'

/** DSH credential reference containing the provider's OAuth token document. */
export const CREDENTIAL_REF_NAME = 'DSH_OAI_OAUTH'

/** Same-origin HTTP prefix used only by this plugin's settings client. */
export const HTTP_PREFIX = '/dsh-oai-oauth'

/** Header required on state-changing browser requests to force a CORS preflight off-origin. */
export const MUTATION_HEADER = 'x-dsh-oai-oauth'
