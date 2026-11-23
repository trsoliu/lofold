import { invoke } from '@tauri-apps/api/core'
import { Check, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { errorMessage } from './archive'
import { ControlSelect, IconAction } from './controls'
import {
  apiProtocols, canonicalAddress, generationEndpoint, loopback, normalizeModel, protocolLabel, readPreferences, validModelId,
  type ApiProtocol, type ModelProfile, type Protocol,
} from './ai-protocols'

const defaultPort = 11434
const portKey = 'lofold.localAiPort'
const serviceKey = 'lofold.aiService'
const preferencesChanged = 'lofoldAiPreferencesChanged'
const refreshModels = 'lofoldAiRefreshModels'

const emptyProfile: ModelProfile = { baseUrl: '', model: '' }

function validPort(value: string) {
  return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
}

function savedPort() {
  const value = localStorage.getItem(portKey) ?? ''
  return validPort(value) ? Number(value) : defaultPort
}

function modelKey(port: number) {
  return port === defaultPort ? 'lofold.localAiModel' : 'lofold.localAiModel.' + port
}

function subscribe(changed: () => void) {
  window.addEventListener('storage', changed)
  window.addEventListener(preferencesChanged, changed)
  return () => {
    window.removeEventListener('storage', changed)
    window.removeEventListener(preferencesChanged, changed)
  }
}

function savePreference(key: string, value: string) {
  localStorage.setItem(key, value)
  window.dispatchEvent(new Event(preferencesChanged))
}

// Serialize native key writes and let the latest service choice determine the active route.
let serviceRevision = 0
let keyWrites: Promise<void> = Promise.resolve()
async function saveService(protocol: Protocol, profile?: ModelProfile, secret?: string) {
  const revision = ++serviceRevision
  const previous = localStorage.getItem(serviceKey)
  if (profile && secret !== undefined) {
    const write = keyWrites.then(async () => {
      await invoke('set_ai_key', { protocol, baseUrl: profile.baseUrl, apiKey: secret })
    })
    keyWrites = write.catch(() => {})
    await write
  }
  if (revision !== serviceRevision || previous !== localStorage.getItem(serviceKey)) return false
  const preferences = readPreferences(previous)
  preferences.active = protocol
  if (protocol !== 'ollama' && profile) preferences.profiles[protocol] = profile
  savePreference(serviceKey, JSON.stringify(preferences))
  return true
}

function useService() {
  return readPreferences(useSyncExternalStore(subscribe, () => localStorage.getItem(serviceKey)))
}

type ModelList = { port: number; names: string[]; error: string }

function useOllamaModels(enabled: boolean) {
  const port = useSyncExternalStore(subscribe, savedPort)
  const saved = useSyncExternalStore(subscribe, () => localStorage.getItem(modelKey(port)))
  const [list, setList] = useState<ModelList>()
  useEffect(() => {
    if (!enabled) return
    let revision = 0
    function load() {
      const request = ++revision
      setList(undefined)
      invoke<{ name: string }[]>('ai_models', { port }).then(
        (items) => {
          if (request === revision) setList({ port, names: items.map(({ name }) => name), error: '' })
        },
        (error: unknown) => {
          if (request === revision) setList({ port, names: [], error: errorMessage(error) })
        },
      )
    }
    load()
    window.addEventListener(refreshModels, load)
    return () => {
      revision++
      window.removeEventListener(refreshModels, load)
    }
  }, [port, enabled])
  const current = list?.port === port ? list : undefined
  const names = current?.names ?? []
  const model = saved && names.includes(saved) ? saved : names[0] ?? ''
  return { port, model, names, loading: !current, error: current?.error }
}

export function useAiConnection() {
  const { active: protocol, profiles } = useService()
  const ollama = useOllamaModels(protocol === 'ollama')
  if (protocol === 'ollama') {
    return { protocol, port: ollama.port, baseUrl: undefined, endpoint: undefined, model: ollama.model, loading: ollama.loading, external: false }
  }
  const { baseUrl, model } = profiles[protocol] ?? emptyProfile
  return { protocol, port: undefined, baseUrl, model, loading: false,
    endpoint: baseUrl && model ? generationEndpoint(protocol, baseUrl, model) : undefined,
    external: !!baseUrl && !loopback(new URL(baseUrl)) }
}

function OllamaSettings({ active, activate }: { active: boolean; activate: () => void }) {
  const { port, model, names, loading, error } = useOllamaModels(true)
  const [input, setInput] = useState(String(port))
  useEffect(() => setInput(String(port)), [port])
  const canApply = validPort(input) && Number(input) !== port

  return <>
    <div className="ai-model">
      <label className="settings-field">本机模型
        <ControlSelect value={model} disabled={loading || !names.length}
          onChange={(event) => savePreference(modelKey(port), event.target.value)}>
          {!names.length && <option value="">{loading ? '正在读取…' : '暂无本机模型'}</option>}
          {names.map((name) => <option key={name} value={name}>{name}</option>)}
        </ControlSelect>
      </label>
      <IconAction icon={RefreshCw} label="刷新模型" aria-busy={loading} disabled={loading}
        onClick={() => window.dispatchEvent(new Event(refreshModels))} />
    </div>
    {error && <p className="ai-feedback" role="alert">{error}</p>}
    {!error && !loading && !names.length &&
      <p className="ai-feedback" role="status">请先在 Ollama 中安装本机 GGUF 对话模型，再刷新列表。</p>}
    <form className="ai-port-row" onSubmit={(event) => {
      event.preventDefault()
      if (canApply) savePreference(portKey, String(Number(input)))
    }}>
      <label className="settings-field">Ollama 端口
        <input value={input} inputMode="numeric" maxLength={5} aria-describedby="ai-port-description"
          onChange={(event) => setInput(event.target.value)} />
      </label>
      <IconAction type="submit" icon={Check} label="应用本机端口" disabled={!canApply} />
    </form>
    <p className="muted" id="ai-port-description">连接到 127.0.0.1，默认端口为 11434。</p>
    {!active && <button className="secondary" type="button" onClick={activate}>使用 Ollama</button>}
  </>
}

function ApiSettings({ protocol, active, saved, lockProvider }: {
  protocol: ApiProtocol; active: boolean; saved: ModelProfile; lockProvider: (locked: boolean) => void
}) {
  const example = apiProtocols[protocol]
  const [address, setAddress] = useState(saved.baseUrl)
  const [model, setModel] = useState(saved.model)
  const [secret, setSecret] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [keyStatus, setKeyStatus] = useState<boolean>()
  const [keyVersion, setKeyVersion] = useState(0)
  const [names, setNames] = useState<string[]>([])
  const [busy, setBusy] = useState<'save' | 'list'>()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const baseUrl = canonicalAddress(address)
  const modelId = normalizeModel(protocol, model)
  const validModel = validModelId(protocol, model)
  const savedAddress = !!baseUrl && baseUrl === saved.baseUrl
  const dirty = !active || !savedAddress || modelId !== saved.model || !!secret || clearKey
  const canList = savedAddress && !secret && !clearKey && !busy

  useEffect(() => {
    let live = true
    setKeyStatus(undefined)
    if (baseUrl) {
      const timer = window.setTimeout(() => {
        invoke<boolean>('ai_key_status', { protocol, baseUrl }).then(
          exists => { if (live) setKeyStatus(exists) },
          issue => { if (live) setError(errorMessage(issue)) },
        )
      }, 300)
      return () => { live = false; window.clearTimeout(timer) }
    }
  }, [protocol, baseUrl, keyVersion])

  function changeAddress(value: string) {
    if (baseUrl !== canonicalAddress(value)) {
      setSecret('')
      setClearKey(false)
      setKeyStatus(undefined)
      setNames([])
    }
    setError('')
    setNotice('')
    setAddress(value)
  }

  async function save() {
    if (!baseUrl || !validModel || busy) return
    setBusy('save')
    lockProvider(true)
    setError('')
    setNotice('')
    try {
      const changed = await saveService(protocol, { baseUrl, model: modelId }, clearKey ? '' : secret || undefined)
      if (!changed) {
        setError('模型设置已在其他界面更改。请重新打开设置后核对。')
        return
      }
      setAddress(baseUrl)
      setModel(modelId)
      setSecret('')
      setClearKey(false)
      setKeyVersion(version => version + 1)
      setNotice(model.trim() ? '已保存模型设置。' : '已保存服务地址，可读取模型列表或填写模型 ID。')
    } catch (issue) { setError(errorMessage(issue)) }
    finally { setBusy(undefined); lockProvider(false) }
  }

  async function listModels() {
    if (!canList) return
    setBusy('list')
    setError('')
    setNotice('')
    setNames([])
    try {
      const items = await invoke<{ name: string }[]>('ai_models', { protocol, baseUrl })
      setNames(items.map(item => item.name))
      if (!items.length) setNotice('服务返回了空列表，可手动填写模型 ID。')
    } catch (issue) { setError(errorMessage(issue)) }
    finally { setBusy(undefined) }
  }

  return <form className="ai-service-form" onSubmit={event => { event.preventDefault(); void save() }}>
    <fieldset disabled={!!busy}>
      <label className="settings-field">服务地址（Base URL）
        <input type="url" maxLength={2048} placeholder={example.address} autoComplete="off" spellCheck={false} value={address}
          onChange={event => changeAddress(event.target.value)} />
      </label>
      {address && !baseUrl && <p className="ai-feedback" role="status">请填写完整的 HTTPS 地址，移除用户名、密码、查询参数和片段。本机回环地址可用 HTTP。</p>}
      <label className="settings-field">API 密钥
        <input type="password" maxLength={4096} autoComplete="new-password" value={secret} disabled={!baseUrl || clearKey}
          placeholder={keyStatus ? '已保存，留空沿用' : '服务需要认证时填写'}
          onChange={event => { setSecret(event.target.value); setNotice('') }} />
      </label>
      {keyStatus && <div className="ai-key-state">
        <span className="muted">{clearKey ? '保存设置后移除该协议和地址的密钥。' : '此协议和地址已有密钥。'}</span>
        {clearKey
          ? <button type="button" className="secondary" onClick={() => setClearKey(false)}>撤销移除</button>
          : <IconAction icon={Trash2} label="移除此地址的密钥" onClick={() => { setSecret(''); setClearKey(true); setNotice('') }} />}
      </div>}
      <div className="ai-model">
        <label className="settings-field">模型 ID
          <input value={model} autoComplete="off" spellCheck={false} maxLength={protocol === 'gemini' ? 263 : 256} placeholder={'例如 ' + example.model}
            onChange={event => { setModel(event.target.value); setNotice('') }} />
        </label>
        <IconAction icon={RefreshCw} label="读取模型列表" aria-busy={busy === 'list'} disabled={!canList}
          onClick={() => void listModels()} />
      </div>
      {!validModel && <p className="ai-feedback" role="alert">{protocol === 'gemini'
        ? 'Gemini 模型 ID 可带 models/ 前缀，名称以字母或数字开头，最多 256 位，可使用字母、数字、点、下划线和短横线。'
        : '模型 ID 最长为 256 字节，不能包含控制字符。'}</p>}
      {!!names.length && <label className="settings-field">可用模型
        <ControlSelect value={names.includes(model) ? model : ''} onChange={event => { setModel(event.target.value); setNotice('') }}>
          <option value="" disabled>选择模型</option>
          {names.map(name => <option key={name} value={name}>{name}</option>)}
        </ControlSelect>
      </label>}
      {baseUrl && !canList && !busy && <p className="muted">保存地址和密钥后，可从该服务读取模型列表。</p>}
      <div className="ai-service-actions">
        <IconAction type="submit" icon={Save} label="保存模型设置" disabled={!baseUrl || !validModel || !dirty || !!busy} />
        {notice && <span className="muted" role="status">{notice}</span>}
      </div>
    </fieldset>
    {error && <p className="ai-feedback" role="alert">{error}</p>}
  </form>
}

export function AiSettings() {
  const saved = useService()
  const configured = localStorage.getItem(serviceKey) !== null || localStorage.getItem(portKey) !== null ||
    localStorage.getItem(modelKey(defaultPort)) !== null
  const [protocol, setProtocol] = useState<Protocol>(configured ? saved.active : 'chat_completions')
  const [saving, setSaving] = useState(false)
  return <section className="account-page" aria-label="大模型设置">
    <div className="account-content settings-content">
      <div className="settings-section ai-settings">
        <label className="settings-field">接口协议
          <ControlSelect aria-label="接口协议" disabled={saving} value={protocol}
            onChange={event => setProtocol(event.target.value as Protocol)}>
            {Object.entries(apiProtocols).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
            <option value="ollama">本机 Ollama</option>
          </ControlSelect>
        </label>
        {configured && protocol !== saved.active && <p className="muted">当前使用 {protocolLabel(saved.active)}。保存后切换到所选协议。</p>}
        {protocol === 'ollama' ? <OllamaSettings active={saved.active === 'ollama'} activate={() => { void saveService('ollama') }} />
          : <ApiSettings key={protocol} protocol={protocol} active={saved.active === protocol}
              saved={saved.profiles[protocol] ?? emptyProfile} lockProvider={setSaving} />}
      </div>
    </div>
  </section>
}
