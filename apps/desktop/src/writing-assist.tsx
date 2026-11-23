import { TextCursorInput, BookmarkPlus, RefreshCw, Settings2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from './archive'
import { ControlSelect, IconAction } from './controls'
import { applicableMemories, soleRecipient } from './writing-context'
import { newMemoryId, readWritingProfile, saveWritingProfile, type WritingRecord } from './writing-profile'
import { WritingProfileEditor } from './writing-settings'
import './writing-assist.css'

type Props = {
  accountId: number | null
  scopeLabel: string
  recipient: string
  cc: string
  bcc: string
  selection: string
  insert: (text: string, signature?: boolean) => void
}

function ProfileDialog({ accountId, scopeLabel, close }: {
  accountId: number | null
  scopeLabel: string
  close: (saved: boolean) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    const modal = dialog.current
    modal?.showModal()
    return () => modal?.close()
  }, [])

  function leave() {
    if (saving) return
    if (dirty) setConfirm(true)
    else close(false)
  }

  return <dialog ref={dialog} className="ai-dialog memory-profile-dialog" aria-labelledby="memory-profile-heading"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (confirm) setConfirm(false); else leave() }}>
    <header>
      <div><h2 id="memory-profile-heading">编辑写作资料</h2><p className="muted">{scopeLabel}</p></div>
      <IconAction icon={X} label="关闭写作资料" disabled={saving} onClick={leave} />
    </header>
    <div className="ai-dialog-content">
      {confirm ? <div className="writing-confirm" role="group" aria-label="放弃写作资料修改">
        <p>写作资料还有未保存的修改。</p>
        <button type="button" className="secondary" autoFocus onClick={() => setConfirm(false)}>继续编辑</button>
        <button type="button" className="secondary" onClick={() => close(false)}>放弃修改</button>
      </div> : null}
      <div hidden={confirm}><WritingProfileEditor accountId={accountId} onDirtyChange={setDirty} onSavingChange={setSaving} onSaved={() => close(true)} /></div>
    </div>
  </dialog>
}

export function WritingAssist({ accountId, scopeLabel, recipient, cc, bcc, selection, insert }: Props) {
  const [record, setRecord] = useState<WritingRecord | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [saveError, setSaveError] = useState('')
  const [forAll, setForAll] = useState(false)
  const target = soleRecipient(recipient, cc, bcc)
  const selectedText = selection.trim()
  const memoryRecipient = forAll || !target ? '' : target

  useEffect(() => {
    if (editing) return
    let active = true
    setLoadError('')
    readWritingProfile(accountId).then(value => {
      if (active) setRecord(value)
    }, error => { if (active) setLoadError(errorMessage(error)) })
    return () => { active = false }
  }, [accountId, attempt, editing])

  useEffect(() => {
    function changed(event: Event) {
      if ((event as CustomEvent).detail === accountId) setAttempt(value => value + 1)
    }
    window.addEventListener('writingProfileChanged', changed)
    return () => window.removeEventListener('writingProfileChanged', changed)
  }, [accountId])

  useEffect(() => {
    setForAll(false)
    setNotice('')
    setSaveError('')
  }, [target, selection])

  const profile = record?.profile
  const matches = profile ? applicableMemories(profile, recipient, cc, bcc) : []
  const tooLong = Array.from(selectedText).length > 300
  const duplicate = matches.some(memory => memory.text === selectedText &&
    (memoryRecipient ? soleRecipient(memory.recipient, '', '') === memoryRecipient : memory.recipient === ''))

  async function remember() {
    if (!record || saving || !selectedText || tooLong || duplicate || record.profile.memories.length >= 24) return
    setSaving(true)
    setSaveError('')
    setNotice('')
    try {
      const memory = { id: newMemoryId(), text: selectedText, recipient: memoryRecipient }
      const saved = await saveWritingProfile(accountId, record.revision, {
        ...record.profile, memories: [...record.profile.memories, memory],
      })
      setRecord(saved)
      setNotice('已记住选中的表述。')
    } catch (error) {
      setSaveError(errorMessage(error))
      setAttempt(value => value + 1)
    } finally {
      setSaving(false)
    }
  }

  return <section className="writing-assist" aria-label="写作记忆">
    <header>
      <div><h3>写作记忆</h3><small>{scopeLabel}</small></div>
      <IconAction icon={Settings2} label="编辑写作资料" aria-haspopup="dialog"
        disabled={saving} onClick={() => { setEditing(true); setSaveError(''); setNotice('') }} />
    </header>
    {editing && <ProfileDialog accountId={accountId} scopeLabel={scopeLabel} close={saved => {
      setEditing(false)
      if (saved) setNotice('写作资料已保存。')
    }} />}
    {loadError ? <p className="memory-feedback" role="alert">{loadError}
      <IconAction icon={RefreshCw} label="重新读取写作记忆" onClick={() => setAttempt(value => value + 1)} />
    </p> : !profile ? <p className="muted" role="status">正在读取写作记忆…</p> : <>
      {(matches.length > 0 || profile.signature) && <ul className="memory-inserts">
        {matches.map(memory => <li key={memory.id}>
          <div><small>{memory.recipient ? '仅用于 ' + memory.recipient : '常用表述'}</small><p>{memory.text}</p></div>
          <IconAction icon={TextCursorInput} label={'插入表述：' + memory.text} title="在光标处插入表述"
            onClick={() => insert(memory.text)} />
        </li>)}
        {profile.signature && <li><div><small>签名</small><p>{profile.signature}</p></div>
          <IconAction icon={TextCursorInput} label="插入签名" onClick={() => insert(profile.signature, true)} />
        </li>}
      </ul>}
      {selectedText ? <div className="memory-selection">
        <p className="memory-excerpt">{selectedText}</p>
        <div>{target ? <label>保存范围 <ControlSelect aria-label="记忆保存范围" value={forAll ? 'all' : 'contact'}
          onChange={event => setForAll(event.target.value === 'all')} disabled={saving}>
          <option value="contact">仅用于 {target}</option><option value="all">此发件身份的所有收件人</option>
        </ControlSelect></label> : <small>适用于此发件身份的所有收件人</small>}
        {target ? <IconAction icon={BookmarkPlus} label="记住选中的表述" disabled={saving || tooLong || duplicate || profile.memories.length >= 24}
          onClick={() => void remember()} /> : <button type="button" className="secondary"
          disabled={saving || tooLong || duplicate || profile.memories.length >= 24} onClick={() => void remember()}>记为通用表述</button>}</div>
        {tooLong ? <small>每条表述最多 300 字，请重新选取。</small> : duplicate && !notice ? <small>此范围已保存这段表述。</small>
          : profile.memories.length >= 24 && <small>已保存 24 条，请先在写作资料中移除一条。</small>}
      </div> : <p className="muted">选中正文中的一句话，即可把它记为常用表述。</p>}
      {notice && <p role="status">{notice}</p>}
      {saveError && <p role="alert">{saveError}</p>}
    </>}
  </section>
}
