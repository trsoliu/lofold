import { invoke } from '@tauri-apps/api/core'
import { Check, Mail, RefreshCw, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { errorMessage, type MailSummary } from './archive'
import { ControlSelect, IconAction } from './controls'
import type { AccountChoice, DraftFields } from './mail-workspace'
import { applicableMemories } from './writing-context'
import { lengthLabels, readWritingProfile, toneLabels, type WritingProfile } from './writing-profile'
import './ai.css'

type Language = 'chinese' | 'english' | 'japanese' | 'korean'
type DraftMode = 'append' | 'replace'
type SelectedProfile = Pick<WritingProfile, 'displayName' | 'role' | 'tone' | 'length'> & { memories: string[] }
type Task =
  | { kind: 'ask'; question: string; accountId: number | null }
  | { kind: 'summary'; messageId: number }
  | { kind: 'translate'; messageId: number; language: Language }
  | { kind: 'draft'; messageId: number | null; instruction: string
      options: { mode: DraftMode; subject: string; body: string; profile: SelectedProfile | null } }

interface Result {
  text: string
  sources: MailSummary[]
  inputTruncated: boolean
  outputIncomplete: boolean
  noMatches: boolean
}

const ai = {
  models: (port: number) => invoke<{ name: string }[]>('ai_models', { port }),
  run: (requestId: string, model: string, port: number, task: Task) => invoke<Result>('run_ai', { requestId, model, port, task }),
  stop: (requestId: string) => invoke<void>('cancel_ai', { requestId }),
}
const defaultPort = 11434
const portKey = 'lofold.localAiPort'
function validPort(value: string) {
  return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
}
function savedPort() {
  const value = localStorage.getItem(portKey) ?? ''
  return validPort(value) ? Number(value) : defaultPort
}
function watchPort(changed: () => void) {
  window.addEventListener('storage', changed)
  window.addEventListener('lofoldAiPortChanged', changed)
  return () => {
    window.removeEventListener('storage', changed)
    window.removeEventListener('lofoldAiPortChanged', changed)
  }
}
function setPort(port: number) {
  localStorage.setItem(portKey, String(port))
  window.dispatchEvent(new Event('lofoldAiPortChanged'))
}

function useAi() {
  const port = useSyncExternalStore(watchPort, savedPort)
  const modelKey = port === defaultPort ? 'lofold.localAiModel' : 'lofold.localAiModel.' + port
  const [listedPort, setListedPort] = useState<number>()
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const current = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setListError('')
    ai.models(port).then(
      (items) => {
        if (!live) return
        const names = items.map(({ name }) => name)
        const saved = localStorage.getItem(modelKey)
        setModels(names)
        setModel(names.find((name) => name === saved) ?? names[0] ?? '')
      },
      (error: unknown) => {
        if (!live) return
        setListError(errorMessage(error))
        setModels([])
        setModel('')
      },
    ).finally(() => {
      if (live) {
        setListedPort(port)
        setLoading(false)
      }
    })
    return () => { live = false }
  }, [version, port, modelKey])

  useEffect(() => {
    setResult(null)
    setIssue('')
    setBusy(false)
    return () => {
      const id = current.current
      current.current = null
      if (id) void ai.stop(id).catch(() => {})
    }
  }, [port])

  function reset() {
    setResult(null)
    setIssue('')
  }

  async function run(task: Task) {
    if (!model || loading || listedPort !== port || current.current) return
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    current.current = id
    reset()
    setBusy(true)
    try {
      const answer = await ai.run(id, model, port, task)
      if (current.current === id) setResult(answer)
    } catch (error) {
      if (current.current === id) setIssue(errorMessage(error))
    } finally {
      if (current.current === id) {
        current.current = null
        setBusy(false)
      }
    }
  }

  return {
    port, models: listedPort === port ? models : [], model: listedPort === port ? model : '',
    loading: loading || listedPort !== port, listError, busy, issue, result, run, reset,
    refresh: () => setVersion((value) => value + 1),
    choose: (value: string) => { setModel(value); localStorage.setItem(modelKey, value); reset() },
    stop: () => { if (current.current) void ai.stop(current.current).catch(() => {}) },
  }
}

type Operation = ReturnType<typeof useAi>

function ModelControl({ operation }: { operation: Operation }) {
  const [input, setInput] = useState(String(operation.port))
  useEffect(() => setInput(String(operation.port)), [operation.port])
  const canApply = validPort(input) && Number(input) !== operation.port && !operation.busy
  return <>
    <div className="ai-model">
      <label>本机模型
        <ControlSelect value={operation.model} disabled={operation.loading || operation.busy || !operation.models.length}
          onChange={(event) => operation.choose(event.target.value)}>
          {!operation.models.length && <option value="">{operation.loading ? '正在读取…' : '暂无本机模型'}</option>}
          {operation.models.map((name) => <option key={name} value={name}>{name}</option>)}
        </ControlSelect>
      </label>
      <IconAction icon={RefreshCw} label="刷新模型" disabled={operation.loading || operation.busy} onClick={operation.refresh} />
    </div>
    <details className="ai-connection">
      <summary>本机连接{operation.port !== defaultPort ? ' · ' + operation.port : ''}</summary>
      <div className="ai-port-row">
        <label>Ollama 端口
          <input value={input} inputMode="numeric" maxLength={5} disabled={operation.busy}
            onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); if (canApply) setPort(Number(input)) }
            }} />
        </label>
        <IconAction icon={Check} label="应用本机端口" disabled={!canApply} onClick={() => setPort(Number(input))} />
      </div>
      <p className="muted">连接到 127.0.0.1，默认端口为 11434。</p>
    </details>
    {operation.listError && <p className="ai-feedback" role="alert">{operation.listError}</p>}
    {!operation.listError && !operation.models.length && !operation.loading &&
      <p className="ai-feedback" role="status">请先在 Ollama 中安装本机 GGUF 对话模型，再刷新列表。</p>}
  </>
}

function Actions({ operation, disabled, label }: { operation: Operation; disabled?: boolean; label: string }) {
  return <div className="ai-actions">
    <button className="secondary ai-primary" type="submit" disabled={disabled || !operation.model || operation.loading || operation.busy}>{label}</button>
    {operation.busy && <><IconAction icon={Square} label="停止推理" onClick={operation.stop} /><span role="status">本机模型正在处理…</span></>}
  </div>
}

function ResultView({ operation, open, reveal = false }: { operation: Operation; open?: (mail: MailSummary) => void; reveal?: boolean }) {
  const { result, issue } = operation
  const preview = useRef<HTMLElement>(null)
  useEffect(() => {
    if (reveal && result?.text && preview.current) {
      preview.current.focus({ preventScroll: true })
      preview.current.scrollIntoView({ block: 'start', behavior: 'instant' })
    }
  }, [reveal, result])
  if (issue) return <p className="ai-feedback" role="alert">{issue}</p>
  if (!result) return null
  if (result.noMatches) return <p className="ai-feedback" role="status">在此范围没有找到匹配邮件。试试更具体的主题、发件人或关键词。</p>
  return <section ref={preview} tabIndex={reveal ? -1 : undefined} className="ai-result" aria-label={reveal ? '草稿预览' : '本机模型结果'}>
    <p className="muted">AI 生成，请结合原文核对。</p>
    {result.inputTruncated && <p className="ai-feedback">本次生成使用了部分正文。</p>}
    {result.outputIncomplete && <p className="ai-feedback">输出达到模型长度上限，结果可能不完整。</p>}
    <div className="ai-output" tabIndex={0}>{result.text}</div>
    {open && result.sources.length > 0 && <>
      <h2>参考原信</h2>
      <ol className="ai-sources">
        {result.sources.map((mail) => <li key={mail.id}>
          <button type="button" className="secondary" onClick={() => open(mail)}>
            <Mail size={16} aria-hidden="true" /><span><strong>{mail.subject || '无主题'}</strong>
              <small>{[mail.accountAddress, mail.sender].filter(Boolean).join(' · ')}</small></span>
          </button>
        </li>)}
      </ol>
    </>}
  </section>
}

export function AiWorkspace({ accounts, account, open, hidden }: {
  accounts: AccountChoice[]
  account: number | null
  open: (mail: MailSummary) => void
  hidden: boolean
}) {
  const operation = useAi()
  const [scope, setScope] = useState(account === null ? '' : String(account))
  const [question, setQuestion] = useState('')
  const valid = scope === 'archive' || accounts.some((item) => String(item.id) === scope)
  return <section className="account-page ai-page" hidden={hidden} aria-labelledby="ai-heading">
    <div className="account-content">
      <h1 id="ai-heading">AI 查信</h1>
      <p className="muted">在所选范围的本机邮件里查找答案，并附上可打开的原信。</p>
      <form className="ai-form" onSubmit={(event) => {
        event.preventDefault()
        if (valid && question.trim()) void operation.run({ kind: 'ask', accountId: scope === 'archive' ? null : Number(scope), question })
      }}>
        <div className="ai-query-controls">
          <label>查信范围
            <ControlSelect value={valid ? scope : ''} disabled={operation.busy}
              onChange={(event) => { setScope(event.target.value); operation.reset() }}>
              <option value="" disabled>选择邮箱范围</option>
              {accounts.map((item) => <option key={item.id} value={item.id}>{item.address}</option>)}
              <option value="archive">整个本机归档（含所有账号）</option>
            </ControlSelect>
          </label>
          <ModelControl operation={operation} />
        </div>
        <label>查信问题
          <textarea value={question} maxLength={1000} rows={3} disabled={operation.busy} placeholder="例如：哪封邮件提到还要补交差旅发票？"
            onChange={(event) => { setQuestion(event.target.value); operation.reset() }} />
        </label>
        <Actions operation={operation} disabled={!valid || !question.trim()} label="查信" />
      </form>
      <ResultView operation={operation} open={open} />
    </div>
  </section>
}

type MailMode = 'summary' | 'translate' | 'draft'
const mailModes: { id: MailMode; label: string }[] = [
  { id: 'summary', label: '摘要' },
  { id: 'translate', label: '翻译' },
  { id: 'draft', label: '拟回复' },
]

export function AiMessageDialog({ message, replyAccountId, close, useDraft }: {
  message: MailSummary
  replyAccountId: number | null
  close: () => void
  useDraft: (text: string) => void
}) {
  const [mode, setMode] = useState<MailMode>('summary')
  const dialog = useRef<HTMLDialogElement>(null)
  const operation = useAi()
  useEffect(() => {
    const modal = dialog.current
    modal?.showModal()
    return () => modal?.close()
  }, [])
  return <dialog className="ai-dialog" ref={dialog} aria-labelledby="ai-message-heading" onCancel={(event) => {
    event.preventDefault()
    close()
  }}>
    <header>
      <div><h2 id="ai-message-heading">本机 AI</h2><p className="muted">{message.subject || '无主题'}</p></div>
      <IconAction icon={X} label="关闭本机 AI" onClick={close} />
    </header>
    <div className="ai-dialog-content">
      <div className="ai-modes" aria-label="邮件 AI 操作">
        {mailModes.map((item) => <button key={item.id} type="button" className="secondary" aria-pressed={item.id === mode}
          disabled={operation.busy} onClick={() => { setMode(item.id); operation.reset() }}>{item.label}</button>)}
      </div>
      {mode === 'draft'
        ? <DraftForm key={message.id} operation={operation} messageId={message.id} replyAccountId={replyAccountId} useDraft={useDraft} />
        : <ReadForm key={mode} operation={operation} mode={mode} messageId={message.id} />}
    </div>
  </dialog>
}

function ReadForm({ operation, mode, messageId }: { operation: Operation; mode: 'summary' | 'translate'; messageId: number }) {
  const [language, setLanguage] = useState<Language>('chinese')
  return <>
    <form className="ai-form" onSubmit={(event) => {
      event.preventDefault()
      void operation.run(mode === 'summary' ? { kind: 'summary', messageId } : { kind: 'translate', messageId, language })
    }}>
      <ModelControl operation={operation} />
      {mode === 'translate' && <label>目标语言
        <ControlSelect value={language} disabled={operation.busy} onChange={(event) => {
          setLanguage(event.target.value as Language)
          operation.reset()
        }}>
          <option value="chinese">简体中文</option><option value="english">英语</option>
          <option value="japanese">日语</option><option value="korean">韩语</option>
        </ControlSelect>
      </label>}
      <Actions operation={operation} label={mode === 'summary' ? '生成摘要' : '翻译正文'} />
    </form>
    <ResultView operation={operation} />
  </>
}

type ApplyDraft = (text: string, mode?: DraftMode) => void

export function AiComposePanel({ useDraft, ...fields }: DraftFields & { useDraft: ApplyDraft }) {
  return <section className="ai-compose" aria-label="AI 拟稿">
    <DraftForm operation={useAi()} messageId={null} fields={fields} useDraft={useDraft} />
  </section>
}

function useScopedProfile(accountId: number | null | undefined) {
  const [loaded, setLoaded] = useState<{ accountId: number | null; profile?: WritingProfile; error?: string }>()
  useEffect(() => {
    if (accountId === undefined) return
    const scope = accountId
    let version = 0
    function load() {
      const request = ++version
      setLoaded(undefined)
      readWritingProfile(scope).then(
        ({ profile }) => { if (request === version) setLoaded({ accountId: scope, profile }) },
        (error: unknown) => { if (request === version) setLoaded({ accountId: scope, error: errorMessage(error) }) },
      )
    }
    function changed(event: Event) { if ((event as CustomEvent).detail === scope) load() }
    load()
    window.addEventListener('writingProfileChanged', changed)
    return () => { version++; window.removeEventListener('writingProfileChanged', changed) }
  }, [accountId])
  return loaded?.accountId === accountId ? loaded : undefined
}

function DraftForm({ operation, messageId, fields, replyAccountId, useDraft }: {
  operation: Operation
  messageId: number | null
  fields?: DraftFields
  replyAccountId?: number | null
  useDraft: ApplyDraft
}) {
  // The message list shows From, but Reply-To is resolved when the reply draft is created.
  const accountId = fields ? fields.accountId : replyAccountId ?? undefined
  const loaded = useScopedProfile(accountId)
  const profile = loaded?.profile
  const { subject = '', body = '', recipient = '', cc = '', bcc = '' } = fields ?? {}
  const [instruction, setInstruction] = useState('')
  const [selectedMode, setSelectedMode] = useState<DraftMode>('append')
  const [enabled, setEnabled] = useState(true)
  const choices = useMemo(() => profile ? applicableMemories(profile, recipient, cc, bcc) : [],
    [profile, recipient, cc, bcc])
  const [picked, setPicked] = useState<{ choices: typeof choices; ids: string[] }>()
  const chosen = picked?.choices === choices ? picked.ids :
    choices.filter((item) => item.recipient).slice(0, 4).map((item) => item.id)
  const hasPreferences = !!profile && !!(profile.displayName || profile.role || profile.tone !== 'default' || profile.length !== 'default')
  const hasContext = hasPreferences || choices.length > 0
  const selectedMemories = choices.filter((item) => chosen.includes(item.id))
  const hasBody = !!body.trim()
  const mode = hasBody ? selectedMode : 'append'
  const tooLong = mode === 'replace' && Array.from(body).length > 2000
  const submitted = useRef<object | null>(null)
  // Keep a result bound to the exact recipients, account, draft, instruction and selection used.
  const generation = useMemo(() => ({}), [accountId, subject, body, recipient, cc, bcc, messageId,
    mode, instruction, choices, picked, enabled, operation.model, operation.port])
  const currentResult = submitted.current === generation
  const action = !fields ? '生成回复草稿' : mode === 'replace' ? '预览润色结果' : hasBody ? '生成续写' : '生成正文'
  const waiting = enabled && accountId !== undefined && !loaded
  const prompt = instruction.trim() || (!fields ? '按原信内容拟一封回复，标出需要我核对的内容。'
    : mode === 'replace' ? '润色正文，让表达清晰自然。' : hasBody ? '结合当前主题和正文，自然续写下一段。' : '')

  return <>
    <form className="ai-form" onSubmit={(event) => {
      event.preventDefault()
      if (!prompt || tooLong || waiting || operation.busy) return
      const selection = enabled && profile && (hasPreferences || selectedMemories.length > 0) ? {
        displayName: profile.displayName, role: profile.role, tone: profile.tone, length: profile.length,
        memories: selectedMemories.map((item) => item.text),
      } : null
      submitted.current = generation
      void operation.run({ kind: 'draft', messageId, instruction: prompt, options: { mode, subject, body, profile: selection } })
    }}>
      <ModelControl operation={operation} />
      {fields && hasBody && <div className="ai-modes" role="group" aria-label="正文编辑方式">
        <button type="button" className="secondary" aria-pressed={mode === 'append'} disabled={operation.busy}
          onClick={() => setSelectedMode('append')}>续写段落</button>
        <button type="button" className="secondary" aria-pressed={mode === 'replace'} disabled={operation.busy}
          onClick={() => setSelectedMode('replace')}>润色正文</button>
      </div>}
      {waiting && <p className="muted ai-context-status" role="status">正在读取写作资料…</p>}
      {loaded?.error && <p className="ai-feedback" role="status">本次拟稿未使用写作资料。{loaded.error}</p>}
      {profile && hasContext && <div className="ai-profile">
        <label className="ai-check"><input type="checkbox" checked={enabled} disabled={operation.busy}
          onChange={(event) => setEnabled(event.target.checked)} />使用本次写作资料</label>
        <details><summary>查看资料{selectedMemories.length > 0 && enabled ? ' · 已选 ' + selectedMemories.length + ' 条表述' : ''}</summary>
          {hasPreferences && <dl>
            {profile.displayName && <><dt>称呼</dt><dd>{profile.displayName}</dd></>}
            {profile.role && <><dt>身份</dt><dd>{profile.role}</dd></>}
            {profile.tone !== 'default' && <><dt>语气</dt><dd>{toneLabels[profile.tone]}</dd></>}
            {profile.length !== 'default' && <><dt>篇幅</dt><dd>{lengthLabels[profile.length]}</dd></>}
          </dl>}
          {choices.length > 0 && <fieldset className="ai-phrases" disabled={!enabled || operation.busy}>
            <legend>本次可用表述（最多 4 条）</legend>
            {choices.map((item) => <label key={item.id} className="ai-check">
              <input type="checkbox" checked={chosen.includes(item.id)} disabled={!chosen.includes(item.id) && chosen.length >= 4}
                onChange={(event) => setPicked({ choices, ids: event.target.checked ? [...chosen, item.id] : chosen.filter((id) => id !== item.id) })} />
              <span>{item.text}</span>
            </label>)}
          </fieldset>}
        </details>
      </div>}
      <label>写信要求
        <textarea value={instruction} maxLength={1000} rows={2} disabled={operation.busy}
          placeholder={mode === 'replace' ? '可补充希望保留的措辞或调整的语气。' : '例如：礼貌地提醒对方周五前提交文件。'}
          onChange={(event) => setInstruction(event.target.value)} />
      </label>
      {tooLong && <p className="ai-feedback" role="status">整篇润色最多支持 2000 字。可缩短正文或选择续写段落。</p>}
      <Actions operation={operation} label={action} disabled={!prompt || tooLong || waiting} />
    </form>
    {currentResult && <ResultView operation={operation} reveal />}
    {!currentResult && (operation.result || operation.busy) && <p className="ai-feedback" role="status">写信内容已更改，请重新生成。</p>}
    {currentResult && mode === 'replace' && operation.result?.outputIncomplete &&
      <p className="ai-feedback">润色结果未写完，请重新生成后再替换正文。</p>}
    {currentResult && operation.result?.text && !(mode === 'replace' && operation.result.outputIncomplete) &&
      <button type="button" className="secondary ai-use" onClick={() => useDraft(operation.result!.text, mode)}>
        {!fields ? '用作回复草稿' : mode === 'replace' ? '替换正文' : '插入当前草稿'}
      </button>}
  </>
}
