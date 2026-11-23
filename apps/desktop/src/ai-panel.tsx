import { invoke } from '@tauri-apps/api/core'
import { Mail, RefreshCw, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage, type MailSummary } from './archive'
import { ControlSelect, IconAction } from './controls'
import type { AccountChoice } from './mail-workspace'
import './ai.css'

type Language = 'chinese' | 'english' | 'japanese' | 'korean'
type Task =
  | { kind: 'ask'; question: string; accountId: number | null }
  | { kind: 'summary'; messageId: number }
  | { kind: 'translate'; messageId: number; language: Language }
  | { kind: 'draft'; messageId: number | null; instruction: string }

interface Result {
  text: string
  sources: MailSummary[]
  inputTruncated: boolean
  outputIncomplete: boolean
  noMatches: boolean
}

const ai = {
  models: () => invoke<{ name: string }[]>('ai_models'),
  run: (requestId: string, model: string, task: Task) => invoke<Result>('run_ai', { requestId, model, task }),
  stop: (requestId: string) => invoke<void>('cancel_ai', { requestId }),
}
const modelKey = 'lofold.localAiModel'

function useAi() {
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
    ai.models().then(
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
    ).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [version])

  useEffect(() => () => {
    const id = current.current
    current.current = null
    if (id) void ai.stop(id).catch(() => {})
  }, [])

  function reset() {
    setResult(null)
    setIssue('')
  }

  async function run(task: Task) {
    if (!model || loading || current.current) return
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    current.current = id
    reset()
    setBusy(true)
    try {
      const answer = await ai.run(id, model, task)
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
    models, model, loading, listError, busy, issue, result, run, reset,
    refresh: () => setVersion((value) => value + 1),
    choose: (value: string) => { setModel(value); localStorage.setItem(modelKey, value); reset() },
    stop: () => { if (current.current) void ai.stop(current.current).catch(() => {}) },
  }
}

type Operation = ReturnType<typeof useAi>

function ModelControl({ operation }: { operation: Operation }) {
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

function ResultView({ operation, open }: { operation: Operation; open?: (mail: MailSummary) => void }) {
  const { result, issue } = operation
  if (issue) return <p className="ai-feedback" role="alert">{issue}</p>
  if (!result) return null
  if (result.noMatches) return <p className="ai-feedback" role="status">在此范围没有找到匹配邮件。试试更具体的主题、发件人或关键词。</p>
  return <section className="ai-result" aria-label="本机模型结果">
    <p className="muted">AI 生成，请结合原文核对。</p>
    {result.inputTruncated && <p className="ai-feedback">本次使用正文片段，完整内容请打开原信。</p>}
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
const mailModes: { id: MailMode; label: string; action: string }[] = [
  { id: 'summary', label: '摘要', action: '生成摘要' },
  { id: 'translate', label: '翻译', action: '翻译正文' },
  { id: 'draft', label: '拟回复', action: '生成回复草稿' },
]

export function AiMessageDialog({ message, close, useDraft }: {
  message: MailSummary
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
      <MailForm key={mode} operation={operation} mode={mode} messageId={message.id} useDraft={useDraft} />
    </div>
  </dialog>
}

export function AiComposePanel({ useDraft }: { useDraft: (text: string) => void }) {
  return <section className="ai-compose" aria-label="AI 拟稿">
    <MailForm operation={useAi()} mode="draft" messageId={null} useDraft={useDraft} />
  </section>
}

function MailForm({ operation, mode, messageId, useDraft }: {
  operation: Operation
  mode: MailMode
  messageId: number | null
  useDraft: (text: string) => void
}) {
  const [language, setLanguage] = useState<Language>('chinese')
  const [instruction, setInstruction] = useState('')
  const selected = mailModes.find((item) => item.id === mode)!
  return <>
    <form className="ai-form" onSubmit={(event) => {
      event.preventDefault()
      if (mode === 'draft') {
        const prompt = instruction.trim() || (messageId !== null ? '写一封简短、礼貌的回复，并标出需要我核对的内容。' : '')
        if (prompt) void operation.run({ kind: 'draft', messageId, instruction: prompt })
      } else if (messageId !== null) {
        void operation.run(mode === 'summary' ? { kind: 'summary', messageId } : { kind: 'translate', messageId, language })
      }
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
      {mode === 'draft' && <label>写信要求
        <textarea value={instruction} maxLength={1000} rows={3} disabled={operation.busy}
          placeholder={messageId === null ? '例如：礼貌地提醒对方周五前提交文件。' : '可补充语气、要回答的问题和时间。'}
          onChange={(event) => { setInstruction(event.target.value); operation.reset() }} />
      </label>}
      <Actions operation={operation} label={mode === 'draft' && messageId === null ? '生成正文' : selected.action}
        disabled={mode === 'draft' && messageId === null && !instruction.trim()} />
    </form>
    <ResultView operation={operation} />
    {mode === 'draft' && operation.result?.text && <button type="button" className="secondary ai-use"
      onClick={() => useDraft(operation.result!.text)}>{messageId === null ? '插入当前草稿' : '用作回复草稿'}</button>}
  </>
}
