import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { errorMessage } from './archive'
import { ControlSelect, IconAction } from './controls'
import type { AccountChoice } from './mail-workspace'
import {
  lengthLabels, newMemoryId, readWritingProfile, saveWritingProfile, toneLabels,
  type WritingMemory, type WritingProfile, type WritingRecord,
} from './writing-profile'
import './writing-settings.css'

interface EditorProps {
  accountId: number | null
  onSaved?: (record: WritingRecord) => void
  onDirtyChange?: (dirty: boolean) => void
  onSavingChange?: (saving: boolean) => void
}

export function WritingProfileEditor(props: EditorProps) {
  return <ProfileForm key={props.accountId ?? 'unassigned'} {...props} />
}

function ProfileForm({ accountId, onSaved, onDirtyChange, onSavingChange }: EditorProps) {
  const [record, setRecord] = useState<WritingRecord | null>(null)
  const [edits, setEdits] = useState<WritingProfile | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmReload, setConfirmReload] = useState(false)
  const dirty = useRef(false)
  const submitting = useRef(false)
  const mounted = useRef(false)
  const newMemoryInput = useRef<string | null>(null)
  const formId = useId()
  const profile = edits ?? record?.profile

  useEffect(() => {
    mounted.current = true
    function changed(event: Event) {
      if ((event as CustomEvent<number | null>).detail !== accountId || submitting.current) return
      if (dirty.current) {
        setIssue('这份资料已有更新。你可以复制本次修改，再重新读取。')
      } else {
        setNotice('')
        setRecord(null)
        setRefresh(value => value + 1)
      }
    }
    window.addEventListener('writingProfileChanged', changed)
    return () => {
      mounted.current = false
      window.removeEventListener('writingProfileChanged', changed)
    }
  }, [accountId])

  useEffect(() => {
    let current = true
    readWritingProfile(accountId).then(
      data => { if (current) setRecord(data) },
      error => { if (current) setIssue(errorMessage(error)) },
    )
    return () => { current = false }
  }, [accountId, refresh])

  function edit(fields: Partial<WritingProfile>) {
    if (!profile || submitting.current) return
    dirty.current = true
    setEdits({ ...profile, ...fields })
    onDirtyChange?.(true)
    setConfirmReload(false)
    setNotice('')
  }

  function reload() {
    dirty.current = false
    setEdits(null)
    onDirtyChange?.(false)
    setIssue('')
    setNotice('')
    setConfirmReload(false)
    setRecord(null)
    setRefresh(value => value + 1)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!record || !edits || submitting.current) return
    submitting.current = true
    setSaving(true)
    onSavingChange?.(true)
    setIssue('')
    setNotice('')
    try {
      const saved = await saveWritingProfile(accountId, record.revision, edits)
      if (mounted.current) {
        setRecord(saved)
        setEdits(null)
        dirty.current = false
        onDirtyChange?.(false)
        setNotice('写作资料已保存在本机。')
        onSaved?.(saved)
      }
    } catch (error) {
      if (mounted.current) setIssue(errorMessage(error))
    } finally {
      submitting.current = false
      if (mounted.current) {
        setSaving(false)
        onSavingChange?.(false)
      }
    }
  }

  if (!profile) return <div className="writing-status">
    {issue ? <><p className="account-notice" role="alert">{issue}</p><IconAction icon={RefreshCw} label="重新读取写作资料" onClick={reload} /></>
      : <p className="muted" role="status">正在读取写作资料…</p>}
  </div>

  const { memories } = profile
  function updateMemory(id: string, changes: Partial<WritingMemory>) {
    edit({ memories: memories.map(memory => memory.id === id ? { ...memory, ...changes } : memory) })
  }

  return <form className="writing-form" aria-label="编辑写作资料" onSubmit={submit}>
    <fieldset disabled={saving}>
      <div className="writing-fields">
        <label className="writing-field">姓名或称呼
          <input autoComplete="off" maxLength={80} value={profile.displayName} onChange={event => edit({ displayName: event.target.value })} />
        </label>
        <label className="writing-field">写信身份
          <input autoComplete="off" maxLength={160} placeholder="例如：项目负责人" value={profile.role} onChange={event => edit({ role: event.target.value })} />
        </label>
        <label className="writing-field">常用语气
          <ControlSelect value={profile.tone} onChange={event => edit({ tone: event.target.value as WritingProfile['tone'] })}>
            {Object.entries(toneLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </ControlSelect>
        </label>
        <label className="writing-field">偏好篇幅
          <ControlSelect value={profile.length} onChange={event => edit({ length: event.target.value as WritingProfile['length'] })}>
            {Object.entries(lengthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </ControlSelect>
        </label>
      </div>
      <label className="writing-field">邮件签名
        <textarea rows={2} maxLength={400} value={profile.signature} onChange={event => edit({ signature: event.target.value })} />
      </label>
      <section className="writing-memories" aria-labelledby={formId + '-memories'}>
        <header>
          <h3 id={formId + '-memories'}>写作记忆</h3>
          <IconAction icon={Plus} label="添加写作记忆" disabled={profile.memories.length >= 24} onClick={() => {
            const id = newMemoryId()
            newMemoryInput.current = id
            edit({ memories: [...profile.memories, { id, text: '', recipient: '' }] })
          }} />
        </header>
        {profile.memories.length === 0 && <p className="muted">存下常用的表述，写信时可直接插入。</p>}
        {profile.memories.length === 24 && <p className="muted">已达到 24 条记忆上限。</p>}
        {profile.memories.map((memory, index) => <div key={memory.id} className="writing-memory-entry">
          <label className="writing-field">常用表述
            <textarea rows={2} required maxLength={300} value={memory.text}
              aria-label={'第 ' + (index + 1) + ' 条常用表述'} ref={element => {
                if (element && newMemoryInput.current === memory.id) {
                  newMemoryInput.current = null
                  element.focus()
                }
              }} onChange={event => updateMemory(memory.id, { text: event.target.value })} />
          </label>
          <IconAction icon={Trash2} label={'移除第 ' + (index + 1) + ' 条写作记忆'}
            onClick={() => edit({ memories: profile.memories.filter(item => item.id !== memory.id) })} />
          <label className="writing-field writing-memory-recipient">适用收件人
            <input type="email" autoComplete="off" spellCheck={false} maxLength={254} placeholder="留空可用于所有收件人"
              aria-label={'第 ' + (index + 1) + ' 条记忆的适用收件人'} value={memory.recipient}
              onChange={event => updateMemory(memory.id, { recipient: event.target.value })} />
          </label>
        </div>)}
      </section>
      <div className="writing-actions">
        <IconAction icon={Save} type="submit" label="保存写作资料" disabled={!edits || confirmReload} />
        {(issue || edits) && <IconAction icon={RefreshCw} label="重新读取写作资料" onClick={() => edits ? setConfirmReload(true) : reload()} />}
        {saving ? <span className="muted" role="status">正在保存…</span>
          : notice ? <span className="muted" role="status">{notice}</span>
            : edits && <span className="muted" role="status">有未保存的修改</span>}
      </div>
      {issue && <p className="account-notice" role="alert">{issue}</p>}
      {confirmReload && <div className="writing-confirm" role="group" aria-label="重新读取资料">
        <span>重新读取将放弃本次修改。</span>
        <button type="button" className="secondary" onClick={() => setConfirmReload(false)}>继续编辑</button>
        <button type="button" className="secondary" onClick={reload}>放弃修改并重新读取</button>
      </div>}
    </fieldset>
  </form>
}

export function WritingSettings({ accounts, initialAccount }: { accounts: AccountChoice[]; initialAccount: number | null }) {
  const [selection, setSelection] = useState<number | null | undefined>(undefined)
  const [requested, setRequested] = useState<number | null | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const candidate = selection === undefined ? initialAccount : selection
  const accountId = accounts.some(account => account.id === candidate) ? candidate : null

  function select(value: number | null) {
    setSelection(value)
    setRequested(undefined)
    setDirty(false)
  }

  return <section className="writing-settings" aria-label="写作资料">
    <div className="writing-settings-heading">
      <h2>写作资料</h2>
      <label className="settings-field">资料所属邮箱
        <ControlSelect disabled={saving} value={accountId ?? ''} onChange={event => {
          const next = event.target.value ? Number(event.target.value) : null
          if (dirty) setRequested(next)
          else select(next)
        }}>
          <option value="">未选择发件邮箱时</option>
          {accounts.map(account => <option key={account.id} value={account.id}>{account.address}</option>)}
        </ControlSelect>
      </label>
    </div>
    {requested !== undefined && <div className="writing-confirm" role="group" aria-label="切换写作资料">
      <span>切换邮箱会放弃尚未保存的修改。</span>
      <button type="button" className="secondary" onClick={() => setRequested(undefined)}>继续编辑</button>
      <button type="button" className="secondary" disabled={saving} onClick={() => select(requested)}>放弃修改并切换</button>
    </div>}
    <WritingProfileEditor accountId={accountId} onSavingChange={setSaving} onDirtyChange={value => {
      setDirty(value)
      if (value) setSelection(accountId)
      else setRequested(undefined)
    }} />
  </section>
}
