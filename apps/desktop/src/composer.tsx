import { BookOpen, FileText, Paperclip, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { errorMessage } from './archive'
import { AiComposePanel } from './ai-panel'
import { ControlSelect, IconAction } from './controls'
import { WritingAssist } from './writing-assist'
import { mailWorkspace, type AccountChoice, type Draft, type DraftFields } from './mail-workspace'

function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`
}

export function Composer({ initial, accounts, close, submitted }: {
  initial: Draft
  accounts: AccountChoice[]
  close: () => void
  submitted: (id: number, account: number | null) => void
}) {
  const [fields, setFields] = useState(initial.fields)
  const [draft, showDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attachmentReminder, setAttachmentReminder] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [panel, setPanel] = useState<'ai' | 'memory' | null>(null)
  const [selection, setSelection] = useState('')
  const [previousBody, setPreviousBody] = useState<string | null>(null)
  const bodyInput = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const currentFields = useRef(initial.fields)
  const savedFields = useRef(initial.fields)
  const currentDraft = useRef(initial)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const actionActive = useRef(false)
  const readonly = draft.status === 'uncertain'
  const connected = accounts.filter((account) => account.connected)

  useEffect(() => {
    const modal = dialog.current
    if (modal && !modal.open) modal.showModal()
    return () => {
      window.clearTimeout(timer.current)
      modal?.close()
    }
  }, [])

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    if (caret !== null) {
      pendingCaret.current = null
      bodyInput.current?.focus()
      bodyInput.current?.setSelectionRange(caret, caret)
    }
  }, [fields, panel])

  function applyDraft(saved: Draft) {
    currentDraft.current = saved
    showDraft(saved)
  }

  function flush() {
    window.clearTimeout(timer.current)
    const snapshot = currentFields.current
    const work = pending.current.then(async () => {
      if (snapshot === savedFields.current || currentDraft.current.status === 'uncertain') return
      setSaving(true)
      try {
        const draft = currentDraft.current
        applyDraft(await mailWorkspace.saveDraft(draft.id, draft.revision, snapshot))
        savedFields.current = snapshot
        setError('')
      } finally {
        setSaving(false)
      }
    })
    pending.current = work.catch(() => {})
    return work
  }

  function update(update: Partial<DraftFields>) {
    const next = { ...currentFields.current, ...update }
    currentFields.current = next
    setFields(next)
    if (update.body !== undefined) {
      setPreviousBody(null)
      setSelection('')
    }
    setAttachmentReminder(false)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void flush().catch((issue: unknown) => setError(errorMessage(issue)))
    }, 360)
  }

  async function perform(action: () => Promise<void>, save = true) {
    if (actionActive.current) return
    actionActive.current = true
    setBusy(true)
    setError('')
    try {
      if (save) {
        await flush()
      } else {
        window.clearTimeout(timer.current)
        await pending.current
      }
      await action()
    } catch (issue) {
      setError(errorMessage(issue))
    } finally {
      setBusy(false)
      actionActive.current = false
    }
  }

  function placeText(body: string, cursor: number) {
    if (body.length > 120000) {
      setError('正文最多 120000 个字符，请缩短后再插入。')
      return false
    }
    pendingCaret.current = cursor
    update({ body })
    setPanel(null)
    return true
  }

  function toggleMemory() {
    const input = bodyInput.current
    if (panel !== 'memory' && input) setSelection(input.value.slice(input.selectionStart, input.selectionEnd))
    setPanel(panel === 'memory' ? null : 'memory')
  }

  function insertMemory(text: string, signature = false) {
    const current = currentFields.current.body
    if (signature) {
      if (current.trimEnd() === text.trimEnd() || current.trimEnd().endsWith('\n' + text.trimEnd())) {
        setError('正文末尾已有这份签名。')
        return
      }
      const body = current ? current + '\n\n' + text : text
      placeText(body, body.length)
      return
    }
    const start = bodyInput.current?.selectionStart ?? current.length
    const end = bodyInput.current?.selectionEnd ?? start
    placeText(current.slice(0, start) + text + current.slice(end), start + text.length)
  }

  function finish() {
    void perform(async () => close())
  }

  function discard() {
    setConfirmDiscard(false)
    void perform(async () => {
      const current = currentDraft.current
      await mailWorkspace.discardDraft(current.id, current.revision)
      close()
    }, false)
  }

  function addAttachment() {
    void perform(async () => {
      const current = currentDraft.current
      const saved = await mailWorkspace.addDraftFile(current.id, current.revision)
      if (saved) {
        applyDraft(saved)
        setAttachmentReminder(false)
      }
    })
  }

  function send(ignoreReminder = false) {
    if (!ignoreReminder && !draft.attachments.length && /附件|随附|attached|attachment/i.test(fields.body)) {
      setAttachmentReminder(true)
      return
    }
    setAttachmentReminder(false)
    void perform(async () => {
      const current = currentDraft.current
      try {
        const result = await mailWorkspace.submit(current.id, current.revision)
        if (result.status === 'accepted') {
          submitted(result.message_id, current.fields.accountId)
          return
        }
        applyDraft(await mailWorkspace.readDraft(current.id))
        setError(result.detail)
      } catch (issue) {
        const latest = await mailWorkspace.readDraft(current.id).catch(() => null)
        if (latest) applyDraft(latest)
        throw issue
      }
    })
  }

  return (
    <dialog ref={dialog} className="composer" data-writing-panel={panel ?? undefined} aria-labelledby="composer-heading" onCancel={(event) => {
      event.preventDefault()
      if (confirmDiscard) setConfirmDiscard(false)
      else if (panel) setPanel(null)
      else finish()
    }}>
      <header className="composer-header">
        <h2 id="composer-heading">写邮件</h2>
        <button type="button" className="icon-button" disabled={busy} onClick={finish} aria-label="保存并关闭草稿"><X size={17} /></button>
      </header>
      <fieldset className="composer-fields" disabled={busy || readonly || confirmDiscard}>
        <div className="compose-row">
          <ControlSelect className="compose-sender" aria-label="发件人" value={fields.accountId ?? ''} onChange={(event) => update({ accountId: event.target.value ? Number(event.target.value) : null })}>
            <option value="">选择发件邮箱</option>
            {fields.accountId !== null && !connected.some((account) => account.id === fields.accountId) &&
              <option value={fields.accountId} disabled>{accounts.find((account) => account.id === fields.accountId)?.address ?? '原发件邮箱'} · 需授权</option>}
            {connected.map((account) => <option value={account.id} key={account.id}>{account.address}</option>)}
          </ControlSelect>
        </div>
        <label className="compose-row">
          <span>收件人</span>
          <input value={fields.recipient} onChange={(event) => update({ recipient: event.target.value })} placeholder="多个地址用逗号分隔" maxLength={500} />
        </label>
        <label className="compose-row">
          <span>抄送</span>
          <input value={fields.cc} onChange={(event) => update({ cc: event.target.value })} maxLength={500} />
        </label>
        <label className="compose-row">
          <span>密送</span>
          <input value={fields.bcc} onChange={(event) => update({ bcc: event.target.value })} maxLength={500} />
        </label>
        <label className="compose-row">
          <span>主题</span>
          <input value={fields.subject} onChange={(event) => update({ subject: event.target.value })} maxLength={380} />
        </label>
        <textarea ref={bodyInput} aria-label="邮件正文" aria-describedby={readonly ? undefined : 'compose-footer-note'} placeholder="写下邮件正文…" value={fields.body} maxLength={120000}
          onSelect={(event) => {
            const input = event.currentTarget
            setSelection(input.value.slice(input.selectionStart, input.selectionEnd))
          }} onChange={(event) => update({ body: event.target.value })} />
        {!readonly && <p id="compose-footer-note" className="compose-footer-note muted">发送时将在正文末尾附上 LoFold 主页链接。</p>}
        {draft.attachments.length > 0 && <ul className="composer-attachments">
          {draft.attachments.map((file) => <li key={file.id}>
            <FileText size={15} aria-hidden="true" />
            <span>{file.name}</span><small>{fileSize(file.size)}</small>
            <button type="button" className="icon-button" aria-label={'移除附件 ' + file.name} onClick={() => void perform(async () => {
              const current = currentDraft.current
              applyDraft(await mailWorkspace.removeDraftFile(current.id, current.revision, file.id))
            })}><X size={14} /></button>
          </li>)}
        </ul>}
      </fieldset>
      {panel === 'memory' && !readonly && !busy && !confirmDiscard &&
        <WritingAssist key={fields.accountId ?? 'shared'} accountId={fields.accountId}
          scopeLabel={accounts.find(account => account.id === fields.accountId)?.address ?? '未选择发件邮箱'}
          recipient={fields.recipient} cc={fields.cc} bcc={fields.bcc} selection={selection} insert={insertMemory} />}
      {panel === 'ai' && !readonly && !busy && !confirmDiscard && <AiComposePanel
        accountId={fields.accountId} recipient={fields.recipient} cc={fields.cc} bcc={fields.bcc} subject={fields.subject} body={fields.body}
        useDraft={(generated, mode) => {
          const current = currentFields.current.body
          const body = mode === 'replace' || !current ? generated : current + '\n\n' + generated
          if (placeText(body, body.length) && mode === 'replace') setPreviousBody(current)
        }} />}
      {previousBody !== null && !readonly && !confirmDiscard && <div className="composer-feedback" role="status">
        已替换正文。<IconAction icon={Undo2} label="撤销正文替换" disabled={busy}
          onClick={() => placeText(previousBody, previousBody.length)} />
      </div>}
      {confirmDiscard && <div className="composer-feedback" role="alert">
        删除此草稿及其附件？
        <button className="secondary" type="button" onClick={() => setConfirmDiscard(false)}>继续编辑</button>
        <button className="secondary" type="button" onClick={discard}>删除草稿</button>
      </div>}
      {attachmentReminder && !confirmDiscard && <div className="composer-feedback" role="alert">
        正文提到了附件。<button className="secondary" onClick={addAttachment}>补上附件</button>
        <button className="secondary" onClick={() => send(true)}>仍然发送</button>
      </div>}
      {readonly && <p className="composer-feedback" role="status">发送结果待确认。请在服务商邮箱核对投递状态。</p>}
      {error && <p className="composer-feedback" role="alert">{error}</p>}
      <footer className="composer-toolbar">
        <IconAction icon={Paperclip} label="添加附件" disabled={busy || readonly || confirmDiscard} onClick={addAttachment} />
        {!readonly && <IconAction icon={BookOpen} label="写作记忆" aria-expanded={panel === 'memory'} disabled={busy || confirmDiscard}
          onClick={toggleMemory} />}
        {!readonly && <IconAction icon={Sparkles} label="AI 拟稿" aria-expanded={panel === 'ai'} disabled={busy || confirmDiscard}
          onClick={() => setPanel(panel === 'ai' ? null : 'ai')} />}
        {!readonly && <IconAction icon={Trash2} label="删除草稿" disabled={busy || confirmDiscard} onClick={() => setConfirmDiscard(true)} />}
        <span className="muted" role="status">{saving ? '正在保存…' : busy ? '正在处理…' : fields === savedFields.current ? '草稿已保存在本机' : '等待保存…'}</span>
        <button className="secondary" disabled={busy} onClick={finish}>{readonly ? '关闭' : '保存并关闭'}</button>
        {!readonly && <button className="secondary compose-primary" disabled={busy || confirmDiscard || !connected.some((account) => account.id === fields.accountId)} onClick={() => send()}>发送</button>}
      </footer>
    </dialog>
  )
}
