import { invoke } from '@tauri-apps/api/core'
import { Mail, Square, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage, type MailSummary } from './archive'
import { useAiConnection } from './ai-settings'
import { protocolLabel, type ApiProtocol } from './ai-protocols'
import { ControlSelect, IconAction } from './controls'
import type { AccountChoice, DraftFields } from './mail-workspace'
import { applicableMemories } from './writing-context'
import { lengthLabels, readWritingProfile, toneLabels, type WritingProfile } from './writing-profile'
import './ai.css'

type Language = 'chinese' | 'english' | 'japanese' | 'korean'
type DraftMode = 'append' | 'replace'
type SelectedProfile = Pick<WritingProfile, 'displayName' | 'role' | 'tone' | 'length'> & { memories: string[] }
type SearchPreview = { question: string; matches: { subject: string; excerpt: string }[] }
type Task =
  | ({ kind: 'answer_search' } & SearchPreview)
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
  searchPreview?: SearchPreview | null
}

type SearchReferences = Pick<Result, 'sources' | 'inputTruncated'>
type Destination = { protocol: ApiProtocol; baseUrl: string; endpoint: string; model: string }
type PendingRequest = Destination & { task: Task; context: string; references?: SearchReferences }

function useAi() {
  const { protocol, port, baseUrl, endpoint, model, loading, external } = useAiConnection()
  const [pending, setPending] = useState<PendingRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const current = useRef<string | null>(null)

  useEffect(() => {
    setResult(null)
    setIssue('')
    setBusy(false)
    setPending(null)
    return () => {
      const id = current.current
      current.current = null
      if (id) void invoke('cancel_ai', { requestId: id }).catch(() => {})
    }
  }, [protocol, port, baseUrl, endpoint, model])

  function reset() {
    setPending(null)
    setResult(null)
    setIssue('')
  }

  function run(task: Task, context = '') {
    if (!model || loading || current.current || pending) return
    if (external) {
      if (protocol !== 'ollama' && baseUrl && endpoint) setPending({ task, context, model, protocol, baseUrl, endpoint })
      return
    }
    void execute(task)
  }

  async function execute(task: Task, confirmed?: PendingRequest) {
    if (!model || loading || current.current) return
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    current.current = id
    reset()
    setBusy(true)
    try {
      const service = protocol === 'ollama' ? { port } : { baseUrl, protocol, confirmedBaseUrl: confirmed?.baseUrl, confirmedEndpoint: confirmed?.endpoint }
      const answer = await invoke<Result>('run_ai', { requestId: id, model, task, ...service })
      if (current.current !== id) return
      if (task.kind === 'ask' && confirmed && answer.searchPreview) {
        setPending({ ...confirmed, task: { kind: 'answer_search', ...answer.searchPreview },
          references: { sources: answer.sources, inputTruncated: answer.inputTruncated } })
      } else {
        const references = confirmed?.references
        setResult(references ? { ...answer, sources: references.sources, inputTruncated: references.inputTruncated || answer.inputTruncated } : answer)
      }
    } catch (error) {
      if (current.current === id) setIssue(errorMessage(error))
    } finally {
      if (current.current === id) {
        current.current = null
        setBusy(false)
      }
    }
  }

  const confirmation = external && pending && pending.protocol === protocol && pending.baseUrl === baseUrl &&
    pending.endpoint === endpoint && pending.model === model ? pending : null
  return {
    protocol, port, baseUrl, model, loading, busy, issue, result, run, reset,
    pending: confirmation,
    dismiss: () => setPending(null),
    confirm: () => { if (confirmation) void execute(confirmation.task, confirmation) },
    stop: () => { if (current.current) void invoke('cancel_ai', { requestId: current.current }).catch(() => {}) },
  }
}

type Operation = ReturnType<typeof useAi>

function externalUse({ task, context }: PendingRequest) {
  const mail = context ? '《' + context + '》' : '所选邮件'
  switch (task.kind) {
    case 'ask':
      return { purpose: '提取查信关键词', material: '本次只发送问题“' + task.question + '”。LoFold 随后在“' + context + '”中查找邮件，有匹配时再请你逐封核对将要发送的摘录。' }
    case 'answer_search':
      return { purpose: '根据邮件摘录回答问题', material: '问题“' + task.question + '”及下方 ' + task.matches.length + ' 封邮件的标题和正文摘录。' }
    case 'summary':
      return { purpose: '生成邮件摘要', material: mail + '的标题和正文，正文最多 7,000 字。' }
    case 'translate':
      return { purpose: '翻译为' + { chinese: '简体中文', english: '英语', japanese: '日语', korean: '韩语' }[task.language], material: mail + '的正文，最多 7,000 字，长文分段发送。' }
    case 'draft': {
      const { mode, body, subject, profile } = task.options
      const parts = ['写信要求“' + task.instruction + '”']
      if (subject.trim()) parts.push('草稿主题“' + subject + '”')
      if (body.trim()) parts.push(mode === 'replace' ? '完整草稿正文' : '草稿正文末尾最多 1,400 字')
      if (task.messageId !== null) parts.push(mail + '的标题和正文（最多 ' + (profile ? '2,800' : '7,000') + ' 字）')
      if (profile) {
        const details = [profile.displayName && '称呼', profile.role && '身份', profile.tone !== 'default' && '语气', profile.length !== 'default' && '篇幅',
          profile.memories.length > 0 && profile.memories.length + ' 条选用表述'].filter(Boolean)
        parts.push('所选写作资料（' + details.join('、') + '）')
      }
      const purpose = task.messageId !== null ? '拟写回复' : mode === 'replace' ? '润色草稿' : body.trim() ? '续写草稿' : '生成草稿'
      return { purpose, material: parts.join('、') + '。' }
    }
  }
}

function ExternalConfirmation({ operation, pending }: { operation: Operation; pending: PendingRequest }) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const { purpose, material } = externalUse(pending)
  const matches = pending.task.kind === 'answer_search' ? pending.task.matches : null
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return createPortal(<dialog ref={ref} className="library-dialog ai-consent" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); operation.dismiss() }}>
    <h2 id={heading}>{matches ? '发送匹配邮件的摘录？' : '发送到模型服务？'}</h2>
    <dl>
      <dt>用途</dt><dd>{purpose}</dd>
      <dt>接口协议</dt><dd>{protocolLabel(pending.protocol)}</dd>
      <dt>服务地址</dt><dd>{pending.endpoint}</dd>
      <dt>模型</dt><dd>{pending.model}</dd>
      <dt>本次资料</dt><dd>{material}</dd>
    </dl>
    {matches && <ol className="ai-match-preview" aria-label="将发送的邮件摘录">
      {matches.map((match, index) => <li key={index}><strong>{match.subject || '无主题'}</strong><p>{match.excerpt}</p></li>)}
    </ol>}
    <div className="ai-actions">
      <button type="button" className="secondary" autoFocus onClick={operation.dismiss}>取消</button>
      <button type="button" className="secondary ai-primary" onClick={operation.confirm}>{matches ? '发送这些摘录' : '确认并发送'}</button>
    </div>
  </dialog>, document.body)
}

function Actions({ operation, disabled, label }: { operation: Operation; disabled?: boolean; label: string }) {
  return <div className="ai-actions">
    <button className="secondary ai-primary" type="submit" disabled={disabled || !operation.model || operation.loading || operation.busy}>{label}</button>
    {operation.pending && <ExternalConfirmation key={operation.pending.task.kind} operation={operation} pending={operation.pending} />}
    {operation.loading && <span role="status">正在读取模型…</span>}
    {!operation.loading && !operation.model && <span className="muted" role="status">模型不可用，请前往「设置 → 大模型」检查。</span>}
    {operation.busy && <><IconAction icon={Square} label="停止推理" onClick={operation.stop} /><span role="status">模型正在处理…</span></>}
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
  return <section ref={preview} tabIndex={reveal ? -1 : undefined} className="ai-result" aria-label={reveal ? '草稿预览' : '模型结果'}>
    <p className="muted">AI 生成，请结合原文核对。</p>
    {result.inputTruncated && <p className="ai-feedback">本次生成使用了部分正文。</p>}
    {result.outputIncomplete && <p className="ai-feedback">输出达到模型长度上限，结果可能不完整。</p>}
    <div className="ai-output" tabIndex={0}>{result.text}</div>
    {open && result.sources.length > 0 && <>
      <h2>参考原信</h2>
      <ol className="ai-sources">
        {result.sources.map((mail) => {
          const subject = mail.subject || '无主题'
          const origin = [mail.accountAddress, mail.sender].filter(Boolean).join(' · ')
          return <li key={mail.id}>
            <button type="button" className="secondary" onClick={() => open(mail)}>
              <Mail size={16} aria-hidden="true" />
              <span className="row-copy">
                <strong className="single-line" title={subject}>{subject}</strong>
                <small className="single-line" title={origin}>{origin}</small>
              </span>
            </button>
          </li>
        })}
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
        if (valid && question.trim()) void operation.run({ kind: 'ask', accountId: scope === 'archive' ? null : Number(scope), question }, scope === 'archive' ? '整个本机归档' : accounts.find(item => String(item.id) === scope)!.address)
      }}>
        <label>查信范围
          <ControlSelect value={valid ? scope : ''} disabled={operation.busy}
            onChange={(event) => { setScope(event.target.value); operation.reset() }}>
            <option value="" disabled>选择邮箱范围</option>
            {accounts.map((item) => <option key={item.id} value={item.id}>{item.address}</option>)}
            <option value="archive">整个本机归档（含所有账号）</option>
          </ControlSelect>
        </label>
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
      <div><h2 id="ai-message-heading">邮件 AI</h2><p className="muted">{message.subject || '无主题'}</p></div>
      <IconAction icon={X} label="关闭邮件 AI" onClick={close} />
    </header>
    <div className="ai-dialog-content">
      <div className="ai-modes" aria-label="邮件 AI 操作">
        {mailModes.map((item) => <button key={item.id} type="button" className="secondary" aria-pressed={item.id === mode}
          disabled={operation.busy} onClick={() => { setMode(item.id); operation.reset() }}>{item.label}</button>)}
      </div>
      {mode === 'draft'
        ? <DraftForm key={message.id} operation={operation} messageId={message.id} mailTitle={message.subject} replyAccountId={replyAccountId} useDraft={useDraft} />
        : <ReadForm key={mode} operation={operation} mode={mode} messageId={message.id} mailTitle={message.subject} />}
    </div>
  </dialog>
}

function ReadForm({ operation, mode, messageId, mailTitle }: { operation: Operation; mode: 'summary' | 'translate'; messageId: number; mailTitle: string }) {
  const [language, setLanguage] = useState<Language>('chinese')
  return <>
    <form className="ai-form" onSubmit={(event) => {
      event.preventDefault()
      void operation.run(mode === 'summary' ? { kind: 'summary', messageId } : { kind: 'translate', messageId, language }, mailTitle || '无主题')
    }}>
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

function DraftForm({ operation, messageId, fields, replyAccountId, mailTitle, useDraft }: {
  operation: Operation
  messageId: number | null
  fields?: DraftFields
  replyAccountId?: number | null
  mailTitle?: string
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
    mode, instruction, choices, picked, enabled, operation.model, operation.port, operation.baseUrl, operation.protocol])
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
      void operation.run({ kind: 'draft', messageId, instruction: prompt, options: { mode, subject, body, profile: selection } }, mailTitle || '无主题')
    }}>
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
