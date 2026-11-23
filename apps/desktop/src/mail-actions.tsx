import { isMac } from './platform'
import { Ellipsis, Flag, Forward, Reply, ReplyAll, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ControlSelect, IconAction } from './controls'
import type { MailSummary } from './archive'
import type { ComposeMode, MailboxAction, MailboxChoice } from './mail-workspace'

type Props = {
  message: MailSummary
  mailboxes: MailboxChoice[]
  blocked: boolean
  compose: (mode: ComposeMode) => void
  change: (action: MailboxAction, target?: number) => void
  pin: () => void
  exportOriginal: () => void
  capture: () => void
  print: () => void
  conversation: () => void
  assistant: () => void
  shareWithAgent?: () => void
}

export function MailActions({ message, mailboxes, blocked, compose, change, pin, exportOriginal, capture, print, conversation, assistant, shareWithAgent }: Props) {
  const [show, setShow] = useState(false)
  const [dialog, setDialog] = useState<'move' | 'delete' | null>(null)
  const [target, setTarget] = useState('')
  const actions = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const modal = useRef<HTMLDialogElement>(null)
  const source = mailboxes.find((folder) => folder.id === message.location?.folderId)
  const destinations = source ? mailboxes.filter((folder) => folder.accountId === source.accountId && folder.id !== source.id) : []
  const junk = destinations.find((folder) => folder.kind === 'junk')
  const promotion = destinations.find((folder) => /^(promotions|推广|推广邮件)$/i.test(folder.label.split(/[/\\]/).pop() ?? ''))
  const trash = destinations.find((folder) => folder.kind === 'trash')
  const inbox = destinations.find((folder) => folder.kind === 'inbox')
  const archived = destinations.find((folder) => folder.kind === 'archive')
  const canMove = Boolean(source && destinations.length)

  useEffect(() => {
    if (!show) return
    function outside(event: PointerEvent) {
      if (!actions.current?.contains(event.target as Node)) setShow(false)
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setShow(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [show])

  useEffect(() => {
    if (dialog && !modal.current?.open) modal.current?.showModal()
  }, [dialog])

  function action(run: () => void) {
    setShow(false)
    run()
  }

  function prompt(kind: 'move' | 'delete') {
    setTarget('')
    setDialog(kind)
  }

  return <div className="reader-actions" role="group" aria-label="常用邮件操作">
    <IconAction icon={Flag} className="reader-flag" label="红旗标记" aria-pressed={!!message.flagged}
      title={!source ? '没有可操作的服务器邮件副本' : message.flagged ? '取消红旗' : '标为红旗'}
      disabled={blocked || !source} onClick={() => action(() => change(message.flagged ? 'unflag' : 'flag'))} />
    <IconAction icon={Reply} label="回复" disabled={blocked} onClick={() => action(() => compose('reply'))} />
    <IconAction icon={ReplyAll} label="回复全部" disabled={blocked} onClick={() => action(() => compose('reply-all'))} />
    <IconAction icon={Forward} label="转发" disabled={blocked} onClick={() => action(() => compose('forward'))} />
    <IconAction icon={Sparkles} label="本机 AI" disabled={blocked} onClick={() => action(assistant)} />
    <div className="message-actions" ref={actions}>
      <button className="secondary icon-action" type="button" ref={trigger} aria-label="更多邮件操作"
        aria-expanded={show} disabled={blocked} title="更多邮件操作" onClick={() => setShow(!show)}>
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      {show && <div className="message-action-popover" role="group" aria-label="邮件操作">
        <button onClick={() => action(() => compose('forward-as-attachment'))}>作为附件转发</button>
        {source?.kind === 'drafts' && <button onClick={() => action(() => compose('edit-server-draft'))}>编辑本机副本</button>}
        <button onClick={() => action(conversation)}>查看同一会话</button>
        {shareWithAgent && <button onClick={() => action(shareWithAgent)}>共享给 Agent MCP…</button>}
        <hr />
        <button onClick={() => action(pin)}>{message.pinned ? '取消本机置顶' : '本机置顶'}</button>
        {source && <>
          <button onClick={() => action(() => change(message.unread ? 'read' : 'unread'))}>{message.unread ? '标为已读' : '标为未读'}</button>
          {canMove && <button onClick={() => action(() => prompt('move'))}>移动到…</button>}
          {archived && <button onClick={() => action(() => change('move', archived.id))}>移至服务器归档</button>}
          {promotion && <button onClick={() => action(() => change('move', promotion.id))}>移至推广邮件</button>}
          {junk && source.kind !== 'trash' && <button onClick={() => action(() => change('move', junk.id))}>移至垃圾邮件</button>}
          {trash && <button className="mail-danger" onClick={() => action(() => change('move', trash.id))}>移至已删除</button>}
          {(source.kind === 'junk' || source.kind === 'trash') && inbox &&
            <button onClick={() => action(() => change('move', inbox.id))}>还原至收件箱</button>}
          {source.kind === 'trash' && <button className="mail-danger" onClick={() => action(() => prompt('delete'))}>彻底删除…</button>}
        </>}
        <hr />
        {isMac && <>
          <button className="message-action-shortcut" aria-keyshortcuts="Meta+Alt+S" onClick={() => action(capture)}>
          保存邮件长图<kbd aria-hidden="true">⌥⌘S</kbd>
        </button>
          <button onClick={() => action(print)}>打印…</button>
        </>}
        <button onClick={() => action(exportOriginal)}>导出 EML 原件</button>
      </div>}
    </div>
    {dialog && <dialog className="mail-action-dialog" ref={modal}
      aria-label={dialog === 'move' ? '移动邮件' : '确认彻底删除'}
      onCancel={() => setDialog(null)} onClose={() => setDialog(null)}>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (dialog === 'move' && !target) return
        setDialog(null)
        if (dialog === 'delete') change('deletePermanently')
        else change('move', Number(target))
      }}>
        <h2>{dialog === 'move' ? '移动邮件' : '彻底删除邮件'}</h2>
        {dialog === 'move'
          ? <label>目标文件夹
            <ControlSelect autoFocus required value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">请选择</option>
              {destinations.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
            </ControlSelect>
          </label>
          : <p>将从邮件服务器永久删除这封邮件。本机归档保留原件。</p>}
        <div className="account-actions">
          <button className="secondary" type="button" autoFocus={dialog === 'delete'} onClick={() => setDialog(null)}>取消</button>
          <button className="secondary" disabled={dialog === 'move' && !target}>{dialog === 'move' ? '移动' : '彻底删除'}</button>
        </div>
      </form>
    </dialog>}
  </div>
}
