import { isAndroid, isMac } from './platform'
import {
  ArrowLeft, Bookmark, Download, FileText, Flag, Mail, Paperclip, Pin, RefreshCw, Search, Settings as SettingsIcon, SquarePen,
  Upload, X,
} from 'lucide-react'
import { StrictMode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { createRoot } from 'react-dom/client'
import { Accounts } from './accounts'
import { agentMcp, AgentMcpSettings, AgentShareDialog, type AgentAction } from './agent-mcp'
import { AiSettings } from './ai-settings'
import { AiMessageDialog, AiWorkspace } from './ai-panel'
import { archive, errorMessage, type MailConversation, type MailDetail, type MailPage, type MailSummary } from './archive'
import { brand, getTheme, logo, setTheme } from './branding'
import { Composer } from './composer'
import { ControlSelect, IconAction } from './controls'
import { Drafts } from './drafts'
import { Attachments, OfflineStorage, PinnedSearches, PinSearch } from './library-tools'
import { MailActions } from './mail-actions'
import { mailWorkspace, type AccountChoice, type ComposeMode, type Draft, type Folder, type MailboxAction, type MailboxChoice } from './mail-workspace'
import { accountStatus, MailboxNavigation, screenLabel, type Screen } from './mailbox-navigation'
import { exportMessageImage, MessageBody, printMessage } from './message-body'
import { getDefaultSender, isSettingsScreen, saveDefaultSender, Settings, SettingsHeader } from './settings'
import { imageAccounts, WatermarkAccountDialog } from './watermark-tools'
import './styles.css'

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' })
const fullDateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const compactDateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const emptyPage: MailPage = { items: [], hasMore: false }
const searchShortcut = isMac ? '⌘K' : 'Ctrl K'

function formatDate(timestamp: number | null) {
  if (timestamp === null) return ''
  return dateFormat.format(timestamp * 1000)
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KiB'
  return (bytes / 1048576).toFixed(1) + ' MiB'
}

function sameMailboxItem(left: MailSummary, right: MailSummary) {
  return left.id === right.id && left.accountId === right.accountId
    && left.location?.folderId === right.location?.folderId
    && left.location?.uidValidity === right.location?.uidValidity && left.location?.uid === right.location?.uid
}

function App() {
  const [screen, setScreen] = useState<Screen>('inbox')
  const [theme, updateTheme] = useState(getTheme)
  const [defaultSender, setDefaultSender] = useState(getDefaultSender)
  const [query, setQuery] = useState('')
  const [attachmentsOnly, setAttachmentsOnly] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [attachmentQuery, setAttachmentQuery] = useState('')
  const [attachmentScope, setAttachmentScope] = useState<number | null>(null)
  const [returnToAttachments, setReturnToAttachments] = useState(false)
  const [returnToAi, setReturnToAi] = useState(false)
  const [aiAccount, setAiAccount] = useState<number | null>(null)
  const [aiMail, setAiMail] = useState<MailSummary | null>(null)
  const [agentMail, setAgentMail] = useState<MailSummary | null>(null)
  const agentAction = useRef<(action: AgentAction) => void>(() => {})
  const [scope, setScope] = useState<number | null>(null)
  const [accounts, setAccounts] = useState<AccountChoice[]>([])
  const [mailboxes, setMailboxes] = useState<MailboxChoice[]>([])
  const [list, setList] = useState(emptyPage)
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [listError, setListError] = useState('')
  const [selected, setSelected] = useState<{ id: number; account: number | null; message?: MailSummary } | null>(null)
  const [detail, setDetail] = useState<MailDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [conversation, setConversation] = useState<{ id: number; account: number | null; result?: MailConversation; error?: string } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState<'import' | 'save' | 'sync' | 'draft' | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftVersion, setDraftVersion] = useState(0)
  const [loadingPage, setLoadingPage] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const [watermarkRequest, setWatermarkRequest] = useState<{ detail: MailDetail; choices: Awaited<ReturnType<typeof imageAccounts>> } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const mailList = useRef<HTMLDivElement>(null)
  const restoreListFocus = useRef(false)
  const readerContent = useRef<HTMLDivElement>(null)
  const listGeneration = useRef(0)
  const readRevision = useRef(0)
  const catalogRequest = useRef(0)
  const discovered = useRef(new Set<number>())
  const openedMailbox = useRef(new Set<number>())
  const remoteId = screen.startsWith('mailbox-') ? Number(screen.slice('mailbox-'.length)) : null
  const remote = mailboxes.find((box) => box.id === remoteId)
  const folder: Folder | null = remoteId !== null ? 'remote'
    : screen === 'archive' || screen === 'inbox' || screen === 'unread' || screen === 'sent'
      || screen === 'flagged' || screen === 'junk' || screen === 'trash' ? screen : null
  const accountFilter = folder === 'archive' ? null : scope
  const selectedId = selected?.id ?? null
  const selectedAccount = selected?.account ?? null
  const connected = accounts.filter((account) => account.connected)
  const scopedAccount = accounts.find((account) => account.id === scope)
  const activeDetail = detail?.id === selectedId ? detail : null
  const activeMessage = selected?.message ?? activeDetail
  const canSync = folder !== null && folder !== 'archive'
  const canPinSearch = folder === 'archive' || folder === 'inbox' || folder === 'unread' || folder === 'sent'
  const activeKind = folder === 'sent' || folder === 'trash' || folder === 'junk' ? folder : 'inbox'
  function matchesMailbox(box: MailboxChoice) {
    if (remoteId !== null) return box.id === remoteId
    if (folder === 'unread' || folder === 'flagged') return box.kind === 'inbox' || box.kind === 'custom' && box.loaded
    return box.kind === activeKind
  }
  const canLoadOlder = canSync && mailboxes.some((box) => (scope === null || scope === box.accountId) && matchesMailbox(box) && box.hasMore)

  useEffect(() => {
    let active = true
    mailWorkspace.accounts().then(
      (items) => { if (active) setAccounts(items) },
      () => {},
    )
    return () => { active = false }
  }, [screen])

  useEffect(() => {
    void reloadMailboxes()
  }, [refresh])

  async function reloadMailboxes() {
    const request = ++catalogRequest.current
    try {
      const items = await mailWorkspace.mailboxes()
      if (request === catalogRequest.current && items) setMailboxes(items)
    } catch (issue) {
      if (request === catalogRequest.current) setNotice({ text: errorMessage(issue), error: true })
    }
  }

  useEffect(() => {
    const pending = accounts.filter((item) => item.connected && !discovered.current.has(item.id))
    if (!pending.length) return
    for (const account of pending) discovered.current.add(account.id)
    void Promise.allSettled(pending.map((account) => mailWorkspace.refreshMailboxes(account.id)))
      .then(reloadMailboxes)
  }, [accounts])

  useEffect(() => {
    if (folder === null) return
    let active = true
    setListStatus('loading')
    setListError('')
    setLoadingPage(false)
    const activeFolder = folder
    function loadPage() {
      const revision = readRevision.current
      archive.list(query, 0, activeFolder, accountFilter, attachmentsOnly, remoteId).then(
        (page) => {
          if (!active) return
          if (revision !== readRevision.current) {
            loadPage()
            return
          }
          setList(page)
          setListStatus('ready')
          mailList.current?.scrollTo(0, 0)
        },
        (error) => {
          if (!active) return
          setListError(errorMessage(error))
          setListStatus('failed')
        },
      )
    }
    const timer = window.setTimeout(loadPage, query.trim() ? 160 : 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [folder, remoteId, accountFilter, query, attachmentsOnly, refresh])

  const showCachedRead = useEffectEvent((mail: MailSummary) => {
    readRevision.current++
    setSelected((item) => item?.message && sameMailboxItem(item.message, mail)
      ? { ...item, message: { ...item.message, unread: false } } : item)
    setList((page) => ({
      ...page,
      items: screen === 'unread'
        ? page.items.filter((item) => !sameMailboxItem(item, mail))
        : page.items.map((item) => sameMailboxItem(item, mail) ? { ...item, unread: false } : item),
    }))
    void reloadMailboxes()
  })

  const markOpened = useEffectEvent(async (mail: MailSummary) => {
    if (!mail.unread || mail.accountId == null || !selected?.message || !sameMailboxItem(selected.message, mail)) return
    if (!reading && window.matchMedia('(max-width: 760px)').matches) return
    try {
      await mailWorkspace.markRead(mail.id, mail.accountId, mail.location)
    } catch (issue) {
      setNotice({ text: '保存本机已读状态失败。' + errorMessage(issue), error: true })
      return
    }
    showCachedRead(mail)
    if (mail.location) {
      try {
        await mailWorkspace.changeMessage(mail.location, 'syncRead')
      } catch (issue) {
        setNotice({ text: '本机已读。服务器未确认，收取此文件夹时会重试。' + errorMessage(issue), error: true })
      }
    }
  })

  useEffect(() => {
    setDetail(null)
    setDetailError('')
    if (selectedId === null) return
    let active = true
    archive.read(selectedId).then(
      (message) => {
        if (!active) return
        setDetail(message)
        if (selected?.message) void markOpened(selected.message)
      },
      (error) => { if (active) setDetailError(errorMessage(error)) },
    )
    return () => { active = false }
  }, [selectedId, selectedAccount, detailRefresh])

  useEffect(() => {
    if (readerContent.current) readerContent.current.scrollTop = 0
  }, [selectedId, selectedAccount])

  useEffect(() => {
    if (reading && detail && window.matchMedia('(max-width: 760px)').matches) {
      detailHeading.current?.focus()
    }
  }, [reading, detail])

  useLayoutEffect(() => {
    if (reading || !restoreListFocus.current) return
    restoreListFocus.current = false
    const currentRow = mailList.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')
    const target = currentRow ?? searchInput.current
    target?.focus({ preventScroll: true })
  }, [reading])

  useEffect(() => {
    if (!notice || notice.error) return
    const timer = window.setTimeout(() => {
      setNotice((current) => current === notice ? null : current)
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if (draft || pinning || aiMail || agentMail || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      if (!folder) goTo('inbox')
      setReading(false)
      requestAnimationFrame(() => {
        searchInput.current?.focus()
        searchInput.current?.select()
      })
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [draft, folder, pinning, aiMail, agentMail])

  useEffect(() => {
    if (!isMac) return
    let disposed = false
    let unlisten: UnlistenFn | undefined
    listen<AgentAction>('lofold://agent-action', ({ payload }) => agentAction.current(payload)).then(
      (stop) => { if (disposed) stop(); else unlisten = stop },
      () => {},
    )
    return () => { disposed = true; unlisten?.() }
  }, [])

  function goTo(next: Screen, account: number | null = null, term = '', requireAttachment = false) {
    if (next === 'ai' && screen !== 'ai' && !returnToAi) setAiAccount(scope)
    listGeneration.current++
    setScreen(next)
    setScope(account)
    setListStatus('loading')
    setQuery(term)
    setAttachmentsOnly(requireAttachment)
    setReturnToAttachments(false)
    setReturnToAi(false)
    setSelected(null)
    setReading(false)
    setRefresh((value) => value + 1)
  }

  function backToList() {
    restoreListFocus.current = true
    setReading(false)
  }

  function changeQuery(value: string) {
    if (value === query) return
    listGeneration.current++
    setListStatus('loading')
    setReading(false)
    setQuery(value)
  }

  function viewMessage(mail: MailSummary) {
    const account = mail.accountId ?? null
    setSelected({ id: mail.id, account, message: mail })
    setReading(true)
    if (selectedId === mail.id && selectedAccount === account) setDetailRefresh((value) => value + 1)
  }

  async function more() {
    if (!folder) return
    const generation = listGeneration.current
    const revision = readRevision.current
    setLoadingPage(true)
    try {
      const page = await archive.list(query, list.items.length, folder, accountFilter, attachmentsOnly, remoteId)
      if (generation === listGeneration.current && revision === readRevision.current) {
        setList((previous) => ({ items: [...previous.items, ...page.items], hasMore: page.hasMore }))
      }
    } catch (error) {
      if (generation === listGeneration.current) setNotice({ text: errorMessage(error), error: true })
    } finally {
      if (generation === listGeneration.current) setLoadingPage(false)
    }
  }

  async function importFile(event?: ChangeEvent<HTMLInputElement>) {
    const file = event?.target.files?.[0]
    if (event) {
      event.target.value = ''
      if (!file) return
    }
    setBusy('import')
    setNotice(null)
    try {
      const result = file ? await archive.import(file) : await archive.pickImport()
      if (!result) return
      goTo('archive')
      setSelected({ id: result.id, account: null })
      setReading(true)
      setNotice({ text: result.duplicate ? '这封邮件已在归档中。' : '邮件已导入本机归档。' })
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function save(attachmentIndex?: number) {
    if (detail === null) return
    setBusy('save')
    setNotice(null)
    try {
      if (await archive.save(detail.id, attachmentIndex)) {
        setNotice({ text: attachmentIndex === undefined ? '邮件原件已保存。' : '附件已保存。' })
      }
    } catch (error) {
      setNotice({ text: errorMessage(error), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function synchronize(accountId = scope, older = false, loadCatalog = true) {
    const targets = connected.filter((account) => accountId === null || accountId === account.id)
    if (!targets.length) return
    setBusy('sync')
    setNotice(null)
    let considered = 0
    let stored = 0
    let skipped = 0
    const failures: string[] = []
    for (const account of targets) {
      try {
        const catalog = older || !loadCatalog ? mailboxes : await mailWorkspace.refreshMailboxes(account.id)
        const folders = catalog.filter((box) => box.accountId === account.id && matchesMailbox(box) && (!older || box.hasMore))
        for (const box of folders) {
          const result = await mailWorkspace.syncMailbox(box.id, older)
          considered += result.considered
          stored += result.stored
          skipped += result.skipped
          if (result.readWarning) failures.push(`${box.label} · 已读状态待同步：${result.readWarning}`)
        }
        if (!folders.length && !older && activeKind === 'inbox' && remoteId === null) {
          const result = await mailWorkspace.sync(account.id)
          considered += result.considered
          stored += result.stored
          skipped += result.skipped
        }
      } catch (issue) {
        failures.push(`${account.address} · ${errorMessage(issue)}`)
      }
    }
    listGeneration.current++
    setRefresh((value) => value + 1)
    const result = `检查 ${considered} 封，新增 ${stored} 封${skipped ? `，暂未收取 ${skipped} 封` : ''}。`
    setNotice({ text: [result, ...failures].join(' '), error: failures.length > 0 })
    setBusy(null)
  }

  useEffect(() => {
    if (scope === null || busy || !(folder === 'remote' || folder === 'sent' || folder === 'junk' || folder === 'trash')) return
    if (!connected.some((item) => item.id === scope)) return
    const next = mailboxes.filter((box) => box.accountId === scope && matchesMailbox(box) && !box.loaded && !openedMailbox.current.has(box.id))
    if (!next.length) return
    for (const box of next) openedMailbox.current.add(box.id)
    void synchronize(scope, false, false)
  }, [folder, remoteId, scope, busy, mailboxes, accounts])

  async function openComposer(mode: 'new' | 'edit' | ComposeMode, id?: number, body?: string, replyAccount = selected?.account ?? null) {
    setBusy('draft')
    setNotice(null)
    try {
      const current = await mailWorkspace.accounts()
      setAccounts(current)
      if (mode === 'edit' && id !== undefined) {
        if (isMac) await agentMcp.takeDraft(id)
        setDraft(await mailWorkspace.readDraft(id))
        return
      }
      const candidates = current.filter((account) => account.connected)
      const preferredDefault = candidates.find((account) => account.id === defaultSender)?.id
      const preferred = mode === 'reply' || mode === 'reply-all'
        ? replyAccount
        : (mode === 'new' ? scope : selected?.account ?? scope)
          ?? preferredDefault ?? (candidates.length === 1 ? candidates[0].id : null)
      const created = await mailWorkspace.createDraft(preferred, id ?? null, mode === 'new' || mode === 'edit' ? 'reply' : mode)
      if (body !== undefined) {
        try {
          setDraft(await mailWorkspace.saveDraft(created.id, created.revision, { ...created.fields, body }))
        } catch (error) {
          await mailWorkspace.discardDraft(created.id, created.revision).catch(() => {})
          throw error
        }
        setAiMail(null)
      } else setDraft(created)
    } catch (issue) {
      setNotice({ text: errorMessage(issue), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function manageMessage(action: MailboxAction | 'pin', target?: number) {
    const message = activeMessage
    const account = selected?.account ?? null
    if (!message || busy !== null) return
    setBusy('save')
    setNotice(null)
    try {
      if (action === 'pin') {
        await mailWorkspace.pinMessage(message.id, account, !message.pinned)
        setSelected((item) => item?.id === message.id && item.account === account
          ? { ...item, message: { ...message, pinned: !message.pinned } } : item)
        setNotice({ text: message.pinned ? '已取消本机置顶。' : '已在本机置顶。' })
      } else if (message.location) {
        const warning = await mailWorkspace.changeMessage(message.location, action, target)
        if (action === 'move' || action === 'deletePermanently') {
          setSelected(null)
          setReading(false)
        } else {
          const updated = action === 'flag' || action === 'unflag'
            ? { ...message, flagged: action === 'flag' } : { ...message, unread: action === 'unread' }
          setSelected((item) => item?.id === message.id && item.account === account ? { ...item, message: updated } : item)
        }
        setNotice({ text: warning ?? '邮件状态已更新。', error: !!warning })
      }
      listGeneration.current++
      setRefresh((value) => value + 1)
    } catch (issue) {
      setNotice({ text: errorMessage(issue), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function outputMessage(action: 'png' | 'print', selection?: { detail: MailDetail; account: number | null }) {
    const detail = selection?.detail ?? activeDetail
    if (!detail || busy !== null) return
    setBusy('save')
    setNotice(null)
    try {
      if (action === 'print') {
        await printMessage(detail)
        return
      }
      let account = selection ? selection.account : selected?.account ?? null
      if (!selection && account === null) {
        const choices = await imageAccounts(detail.id)
        if (choices.linked && choices.accounts.length === 1) {
          account = choices.accounts[0].id
        } else {
          setWatermarkRequest({ detail, choices })
          return
        }
      }
      if (await exportMessageImage(detail, account)) {
        setNotice({ text: account === null ? '已保存无水印长图。' : '邮件长图已保存，已嵌入暗水印。' })
      }
    } catch (issue) {
      setNotice({ text: errorMessage(issue), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function openConversation(id: number, account: number | null) {
    setConversation({ id, account })
    try {
      const result = await archive.conversation(id, account)
      setConversation((previous) => previous?.id === id && previous.account === account ? { id, account, result } : previous)
    } catch (error) {
      setConversation((previous) => previous?.id === id && previous.account === account
        ? { id, account, error: errorMessage(error) } : previous)
    }
  }

  useEffect(() => {
    function capture(event: KeyboardEvent) {
      if (!isMac || !activeDetail || busy || draft || pinning || watermarkRequest || event.isComposing || event.shiftKey || !event.altKey
        || !(event.metaKey || event.ctrlKey) || event.code !== 'KeyS') return
      if ((event.target as HTMLElement | null)?.closest('input,textarea,select,dialog,[contenteditable]')) return
      event.preventDefault()
      void outputMessage('png')
    }
    window.addEventListener('keydown', capture)
    return () => window.removeEventListener('keydown', capture)
  }, [activeDetail, busy, draft, pinning, selected?.account, watermarkRequest])

  const label = remoteId !== null ? remote?.label ?? '服务器文件夹' : screenLabel(screen, scope)
  const pageScoped = folder && folder !== 'archive'
  const scopeStatus = scopedAccount ? accountStatus(scopedAccount) : null
  const preferences = isSettingsScreen(screen)
  const replyAccountId = aiMail && selected?.id === aiMail.id && selected.account === aiMail.accountId
    ? selected.account : null

  agentAction.current = (action) => {
    if (action.kind === 'draft_changed') {
      setDraftVersion((value) => value + 1)
      return
    }
    if (draft || busy || pinning || aiMail || agentMail || watermarkRequest) {
      setNotice({ text: action.kind === 'open_draft'
        ? '当前操作结束后，可在「所有草稿」中打开 Agent 草稿。'
        : '当前正在操作邮件。关闭当前操作后可重新请求 Agent 查信。' })
      return
    }
    if (action.kind === 'open_search') goTo(action.scope, null, action.query)
    else void openComposer('edit', action.id)
  }

  const timestamp = activeDetail?.sentAt
  const fullTimestamp = timestamp == null ? '' : fullDateFormat.format(timestamp * 1000)
  const readerBack = returnToAi
    ? <IconAction className="reader-back" icon={ArrowLeft} label="返回 AI 查信" onClick={() => goTo('ai')} />
    : returnToAttachments
    ? <IconAction className="reader-back" icon={ArrowLeft} label="返回附件中心" onClick={() => goTo('attachments')} />
    : reading && <IconAction className="reader-back reader-back-compact" icon={ArrowLeft} label="返回列表" onClick={backToList} />

  return (
    <div className="shell" data-native-titlebar={isMac} data-reading={reading}>
      <div className="brand" data-tauri-drag-region="deep">
        <img src={logo} alt="" width="23" height="23" />
        <span>{brand.name}</span>
      </div>
      <header className="sidebar">
        <IconAction className="sidebar-compose" icon={SquarePen} label="写邮件"
          disabled={busy !== null} onClick={() => void openComposer('new')} />
        <input ref={fileInput} type="file" accept=".eml,message/rfc822" aria-label="选择 EML 文件" hidden onChange={importFile} />

        <MailboxNavigation screen={screen} scope={scope} accounts={accounts} mailboxes={mailboxes} navigate={goTo} />

        <div className="sidebar-utility">
          <IconAction icon={SettingsIcon} label="设置" aria-current={preferences ? 'page' : undefined}
            onClick={() => goTo('accounts')} />
        </div>
      </header>

      <main className="workspace" data-reading={reading} data-screen={screen} data-preferences={preferences}>
        {preferences && <SettingsHeader screen={screen} navigate={goTo} />}
        {isMac && screen === 'agent-mcp' && <AgentMcpSettings />}
        {(screen === 'settings' || screen === 'appearance') && <Settings section={screen} theme={theme} changeTheme={(id) => updateTheme(setTheme(id))}
          accounts={accounts} defaultSender={defaultSender} changeDefault={(account) => {
            saveDefaultSender(account)
            setDefaultSender(account)
          }} />}
        {screen === 'ai-settings' && <AiSettings />}
        {screen === 'accounts' && <Accounts onAccounts={setAccounts} onRemoved={(id) => {
          setAccounts((items) => items.filter((account) => account.id !== id))
          setMailboxes((items) => items.filter((mailbox) => mailbox.accountId !== id))
          discovered.current.delete(id)
          setAttachmentScope((account) => account === id ? null : account)
          if (defaultSender === id) {
            saveDefaultSender(null)
            setDefaultSender(null)
          }
          setRefresh((value) => value + 1)
          setDraftVersion((value) => value + 1)
        }} onViewMessage={(id) => {
          goTo('archive')
          setSelected({ id, account: null })
          setReading(true)
        }} />}
        {screen === 'drafts' && <Drafts key={scope ?? 'all'} scope={scope} title={label} version={draftVersion}
          accounts={accounts} edit={(id) => void openComposer('edit', id)}
          serverDrafts={mailboxes.filter((box) => box.kind === 'drafts' && (scope === null || scope === box.accountId))}
          openServerDrafts={(box) => goTo(`mailbox-${box.id}`, box.accountId)} />}
        {screen === 'attachments' && <Attachments accounts={accounts} query={attachmentQuery} scope={attachmentScope} changeQuery={setAttachmentQuery} changeScope={setAttachmentScope} openMessage={(id) => {
          goTo('archive')
          setReturnToAttachments(true)
          setSelected({ id, account: null })
          setReading(true)
        }} />}
        {screen === 'saved' && <PinnedSearches accounts={accounts} open={(spec) => {
          if (spec.folder !== 'remote') goTo(spec.folder, spec.accountId, spec.query, spec.attachmentsOnly)
        }} />}
        {screen === 'offline' && <OfflineStorage accounts={accounts} version={refresh} syncing={busy !== null} refresh={(id) => void synchronize(id)} />}
        {(screen === 'ai' || returnToAi) && <AiWorkspace accounts={accounts} account={aiAccount} hidden={screen !== 'ai'}
          open={(mail) => {
            goTo('archive')
            setReturnToAi(true)
            viewMessage(mail)
          }} />}
        {folder && <>
          <section className="mailbox" aria-label="邮件列表">
            <header className="mailbox-toolbar" aria-label="邮件操作">
              <div className="mailbox-heading" data-tauri-drag-region>
                <h1 className="single-line" title={label} data-tauri-drag-region>{label}</h1>
                {pageScoped && folder !== 'remote' && <ControlSelect className="scope-select toolbar-scope" value={scope ?? ''}
                  aria-label="选择邮箱范围" title={scopedAccount?.address ?? '所有账号'}
                  onChange={(event) => goTo(folder, event.target.value ? Number(event.target.value) : null, query, attachmentsOnly)}>
                  <option value="">所有账号</option>
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
                </ControlSelect>}
                {canSync && <IconAction icon={RefreshCw} label={busy === 'sync' ? '正在收取' : '收取'}
                  aria-busy={busy === 'sync'} disabled={busy !== null || loadingPage || !connected.some((item) => scope === null || scope === item.id)}
                  onClick={() => void synchronize()} title="收取当前文件夹的最新邮件" />}
                {folder === 'archive' && <IconAction icon={Upload} label={busy === 'import' ? '正在导入' : '导入 EML'}
                  aria-busy={busy === 'import'} disabled={busy !== null || loadingPage} onClick={() => isAndroid ? void importFile() : fileInput.current?.click()} />}
              </div>
              <div className="mailbox-search">
                <div className="search">
                  <Search size={16} aria-hidden="true" />
                  <input ref={searchInput} type="search" maxLength={160} value={query} onChange={(event) => changeQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) changeQuery('') }}
                    placeholder="搜索当前范围" aria-label="搜索邮件" aria-keyshortcuts="Meta+K Control+K" />
                  {query
                    ? <button className="icon-button" onClick={() => { changeQuery(''); searchInput.current?.focus() }} aria-label="清空搜索"><X size={15} /></button>
                    : <kbd className="search-shortcut" aria-hidden="true">{searchShortcut}</kbd>}
                </div>
                {canPinSearch && (query.trim() || attachmentsOnly) &&
                  <IconAction icon={Bookmark} label="固定搜索" onClick={() => setPinning(true)} />}
              </div>
            </header>
            <div ref={mailList} className="mail-list" aria-busy={listStatus === 'loading'}>
              {listStatus === 'loading' && <p className="list-message" role="status">正在读取邮件…</p>}
              {listStatus === 'failed' && <div className="list-message"><p role="alert">{listError}</p><button className="secondary" onClick={() => setRefresh((v) => v + 1)}>重试</button></div>}
              {listStatus === 'ready' && (list.items.length === 0
                ? <p className="list-message">{query.trim() || attachmentsOnly ? '没有匹配的邮件。'
                  : folder === 'archive' ? '导入 .eml 文件后，邮件会显示在这里。'
                  : scopeStatus ? `此邮箱${scopeStatus}。可前往「邮箱账号」查看。`
                  : !connected.length ? '请先在「邮箱账号」中授权一个邮箱。'
                  : remote?.loaded ? '此文件夹暂无已缓存的邮件。'
                  : '当前没有已缓存的邮件。点击「收取」检查服务器。'}</p>
                : <ul>{list.items.map((mail) => (
                  <li key={mail.id + '/' + (mail.accountId ?? '')}>
                    <button className="mail-row" data-unread={mail.unread || undefined} aria-current={selected?.id === mail.id && selected?.account === (mail.accountId ?? null) ? 'true' : undefined} onClick={() => viewMessage(mail)}>
                      <span className="row-title">
                        <span>{mail.unread && <span className="unread-dot" role="img" aria-label="未读" />}{mail.subject || '无主题'}</span>
                        {mail.pinned && <Pin aria-label="本机置顶" size={14} />}
                        {mail.flagged && <Flag className="message-flag" role="img" aria-label="红旗邮件" size={14} />}
                        {mail.hasAttachments && <Paperclip aria-label="有附件" size={14} />}
                      </span>
                      <span className="row-meta"><span className="sender">{mail.sender || '未知发件人'}</span><span className="date">{formatDate(mail.sentAt)}</span></span>
                      {mail.preview && <span className="preview">{mail.preview}</span>}
                      {mail.accountAddress && accountFilter === null && <span className="mail-account">{mail.accountAddress}</span>}
                    </button>
                  </li>
                ))}</ul>)}
              {listStatus === 'ready' && list.hasMore && <button className="secondary show-more" disabled={busy === 'import' || loadingPage} onClick={more}>{loadingPage ? '正在加载' : '加载更多'}</button>}
              {listStatus === 'ready' && !list.hasMore && canLoadOlder && <button className="secondary show-more"
                disabled={busy !== null} onClick={() => void synchronize(scope, true)}>收取更早邮件</button>}
            </div>
          </section>

          <section className="reader" aria-label="邮件内容">
            <div className="reader-content" ref={readerContent}>
              {!activeDetail && readerBack}
              {selectedId === null && <div className="reader-placeholder"><span className="placeholder-icon"><Mail size={22} strokeWidth={1.6} aria-hidden="true" /></span><p>选择一封邮件阅读</p></div>}
              {selectedId !== null && !activeDetail && (detailError
                ? <div className="reader-placeholder"><p role="alert">{detailError}</p><button className="secondary" onClick={() => setDetailRefresh((v) => v + 1)}>重试</button></div>
                : <div className="reader-placeholder" role="status">正在打开邮件…</div>)}
              {activeDetail && <article className="message">
                <header className="message-header">
                  <div className="message-title">
                    {readerBack}
                    <h2 ref={detailHeading} tabIndex={-1}>{activeDetail.subject || '无主题'}</h2>
                  </div>
                  <dl className="message-meta">
                    <div><dt>发件人</dt><dd>{activeDetail.sender || '未知发件人'}</dd></div>
                    {activeDetail.recipients && <div><dt>收件人</dt><dd>{activeDetail.recipients}</dd></div>}
                  </dl>
                  {(timestamp != null || activeMessage) && <div className="message-time-row">
                    {timestamp != null && <dl className="message-meta message-timestamp">
                      <div>
                        <dt>时间</dt>
                        <dd className="single-line" title={fullTimestamp}>
                          <span className="message-time-full">{fullTimestamp}</span>
                          <span className="message-time-compact">{compactDateFormat.format(timestamp * 1000)}</span>
                        </dd>
                      </div>
                    </dl>}
                    {activeMessage && <MailActions key={activeDetail.id + ':' + selected?.account} message={activeMessage}
                      mailboxes={mailboxes} blocked={busy !== null}
                      compose={(mode) => void openComposer(mode, activeDetail.id)} change={(action, target) => void manageMessage(action, target)}
                      pin={() => void manageMessage('pin')} exportOriginal={() => void save()}
                      capture={() => void outputMessage('png')} print={() => void outputMessage('print')}
                      assistant={() => setAiMail(activeMessage)}
                      shareWithAgent={isMac ? () => setAgentMail(activeMessage) : undefined}
                      conversation={() => void openConversation(activeDetail.id, selected?.account ?? null)} />}
                  </div>}
                </header>
                {conversation?.id === activeDetail.id && conversation.account === selected?.account &&
                  <section className="mail-conversation" aria-label="本机会话">
                    <header><strong>本机会话</strong><IconAction icon={X} label="关闭会话" onClick={() => setConversation(null)} /></header>
                    {conversation.error ? <p role="alert">{conversation.error}</p>
                      : !conversation.result ? <p role="status">正在查找往来邮件…</p>
                      : <>{conversation.result.items.filter((message) => message.id !== activeDetail.id).map((message) =>
                        <button className="secondary conversation-row" key={message.id} onClick={() => {
                          setConversation(null)
                          viewMessage(message)
                        }}>
                          <span className="single-line" title={message.subject || '无主题'}>{message.subject || '无主题'}</span>
                          <small>{formatDate(message.sentAt)}</small>
                        </button>)}
                        {conversation.result.items.length < 2 && <p className="muted">本机暂未找到其他往来邮件。</p>}
                        {conversation.result.indexingPending && <button className="secondary"
                          onClick={() => void openConversation(conversation.id, conversation.account)}>查找更早的本机邮件</button>}
                        {conversation.result.hasMore && <p className="muted">已展示最近的往来邮件。</p>}
                      </>}
                  </section>}
                <MessageBody detail={activeDetail} theme={theme} />
                {activeDetail.attachments.length > 0 && <section className="attachments" aria-label="附件">
                  {activeDetail.attachments.map((file) => (
                    <button className="attachment" key={file.index} disabled={busy !== null} onClick={() => save(file.index)} aria-label={'保存附件 ' + file.name}>
                      <FileText size={20} aria-hidden="true" />
                      <span className="row-copy"><strong className="single-line" title={file.name}>{file.name}</strong><small>{formatSize(file.size)}</small></span>
                      <Download size={16} aria-hidden="true" />
                    </button>
                  ))}
                </section>}
              </article>}
            </div>
          </section>
        </>}
      </main>
      {aiMail && <AiMessageDialog key={aiMail.id} message={aiMail} replyAccountId={replyAccountId} close={() => setAiMail(null)}
        useDraft={(body) => void openComposer('reply', aiMail.id, body, replyAccountId)} />}
      {agentMail && <AgentShareDialog key={agentMail.id} mail={agentMail} close={() => setAgentMail(null)}
        shared={() => { setAgentMail(null); setNotice({ text: '已共享。可在「设置 → Agent MCP」撤回。' }) }} />}
      {pinning && folder && canPinSearch && <PinSearch spec={{ folder, accountId: accountFilter, query, attachmentsOnly }}
        close={() => setPinning(false)} saved={() => { setPinning(false); setNotice({ text: '已固定搜索。' }) }} />}
      {draft && <Composer key={draft.id} initial={draft} accounts={accounts}
        close={() => { setDraft(null); setDraftVersion((v) => v + 1) }}
        submitted={(id, account) => {
          setDraft(null)
          setDraftVersion((v) => v + 1)
          goTo('sent', account)
          setSelected({ id, account })
          setReading(true)
          setNotice({ text: 'SMTP 服务商已接受邮件。本机已保存发送副本。' })
        }} />}
      {watermarkRequest && <WatermarkAccountDialog choices={watermarkRequest.choices} close={() => setWatermarkRequest(null)}
        save={(account) => {
          setWatermarkRequest(null)
          void outputMessage('png', { detail: watermarkRequest.detail, account })
        }} />}
      {notice && <div className="notice" data-error={!!notice.error}>
        <span role={notice.error ? 'alert' : 'status'}>{notice.text}</span>
        <button className="icon-button" aria-label="关闭通知" onClick={() => setNotice(null)}><X size={16} /></button>
      </div>}
    </div>
  )
}

setTheme(getTheme().id)
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
