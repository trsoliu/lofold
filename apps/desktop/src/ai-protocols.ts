export type ApiProtocol = 'chat_completions' | 'responses' | 'anthropic' | 'gemini'
export type Protocol = ApiProtocol | 'ollama'
export type ModelProfile = { baseUrl: string; model: string }

export const apiProtocols = {
  chat_completions: { label: 'OpenAI Chat Completions', address: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  responses: { label: 'OpenAI Responses', address: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  anthropic: { label: 'Anthropic Messages', address: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  gemini: { label: 'Google Gemini', address: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
} satisfies Record<ApiProtocol, { label: string; address: string; model: string }>

export function protocolLabel(protocol: Protocol) {
  return protocol === 'ollama' ? '本机 Ollama' : apiProtocols[protocol].label
}

function isApiProtocol(value: unknown): value is ApiProtocol {
  return typeof value === 'string' && Object.hasOwn(apiProtocols, value)
}

export function loopback(url: URL) {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
}

export function canonicalAddress(value: string) {
  const input = value.trim()
  const authority = input.split('://')[1]?.split('/')[0]
  if (!authority || authority.includes('@') || new TextEncoder().encode(input).length > 2048 || /[\u0000-\u001f\u007f]/.test(input)) return ''
  if (!/^https?:\/\//i.test(input) || /[?#\\\s]/.test(input)) return ''
  try {
    const url = new URL(input)
    if (url.port === '0' || url.username || url.password || (url.protocol !== 'https:' && !loopback(url))) return ''
    const canonical = url.href.replace(/\/+$/, '')
    return canonical.length <= 2048 ? canonical : ''
  } catch {
    return ''
  }
}

export function normalizeModel(protocol: ApiProtocol, value: string) {
  const model = value.trim()
  return protocol === 'gemini' ? model.replace(/^models\//, '') : model
}

export function validModelId(protocol: ApiProtocol, value: string) {
  const normalized = normalizeModel(protocol, value)
  if (!value.trim()) return true
  if (protocol === 'gemini') return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(normalized)
  return new TextEncoder().encode(normalized).length <= 256 && !/[\u0000-\u001f\u007f]/.test(normalized)
}

export function generationEndpoint(protocol: ApiProtocol, baseUrl: string, model: string) {
  switch (protocol) {
    case 'chat_completions': return baseUrl + '/chat/completions'
    case 'responses': return baseUrl + '/responses'
    case 'anthropic': return baseUrl + '/messages'
    case 'gemini': return baseUrl + '/models/' + normalizeModel(protocol, model) + ':generateContent'
  }
}

type Preferences = { active: Protocol; profiles: Partial<Record<ApiProtocol, ModelProfile>> }

function readProfile(value: unknown, protocol: ApiProtocol): ModelProfile | undefined {
  if (!value || typeof value !== 'object' || !('baseUrl' in value) || typeof value.baseUrl !== 'string') return undefined
  const baseUrl = canonicalAddress(value.baseUrl)
  if (!baseUrl) return undefined
  const model = 'model' in value && typeof value.model === 'string' ? value.model : ''
  return { baseUrl, model: validModelId(protocol, model) ? normalizeModel(protocol, model) : '' }
}

export function readPreferences(raw: string | null): Preferences {
  const preferences: Preferences = { active: 'ollama', profiles: {} }
  if (!raw) return preferences
  try {
    const data = JSON.parse(raw)
    if (data.active === 'ollama' || isApiProtocol(data.active)) {
      preferences.active = data.active
      for (const [protocol, value] of Object.entries(data.profiles ?? {})) {
        if (!isApiProtocol(protocol)) continue
        const profile = readProfile(value, protocol)
        if (profile) preferences.profiles[protocol] = profile
      }
    } else if (data.provider === 'ollama' || data.provider === 'compatible') {
      // Older installs kept the compatible service fields when switching to Ollama.
      preferences.active = data.provider === 'compatible' ? 'chat_completions' : 'ollama'
      const previous = readProfile(data, 'chat_completions')
      if (previous) preferences.profiles.chat_completions = previous
    }
  } catch { /* Installations predating service profiles use the existing Ollama keys. */ }
  return preferences
}
