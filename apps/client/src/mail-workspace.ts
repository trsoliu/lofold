import { invoke } from '@tauri-apps/api/core'

export type Folder = 'archive' | 'inbox' | 'unread' | 'sent' | 'flagged' | 'junk' | 'trash' | 'remote'
export type MailboxKind = 'inbox' | 'sent' | 'drafts' | 'junk' | 'trash' | 'archive' | 'custom'

export interface MailboxChoice {
  id: number
  accountId: number
  label: string
  kind: MailboxKind
  loaded: boolean
  hasMore: boolean
  count: number
  unread: number
}

export interface MailLocation {
  folderId: number
  uidValidity: number
  uid: number
}

export type MailboxAction = 'read' | 'unread' | 'flag' | 'unflag' | 'move' | 'deletePermanently'

export interface MailServer {
  host: string
  port: number
  username: string
  startTls: boolean
}

export type ServerSettings = Record<'imap' | 'smtp', MailServer>

export interface AccountChoice {
  id: number
  address: string
  connected: boolean
  canAuthorize: boolean
  servers?: ServerSettings | null
}

export type ComposeMode = 'reply' | 'reply-all' | 'forward' | 'forward-as-attachment' | 'edit-server-draft'

export interface DraftFields {
  accountId: number | null
  recipient: string
  cc: string
  bcc: string
  subject: string
  body: string
}

export interface Draft {
  id: number
  revision: number
  fields: DraftFields
  status: 'editing' | 'rejected' | 'uncertain'
  changedAt: number
  attachments: { id: number; name: string; size: number }[]
}

type SubmitResult = { status: 'accepted'; message_id: number }
  | { status: 'rejected' | 'uncertain'; detail: string }

export const mailWorkspace = {
  accounts: () => invoke<AccountChoice[]>('list_accounts'),
  mailboxes: () => invoke<MailboxChoice[]>('list_mailboxes'),
  refreshMailboxes: (account: number) => invoke<MailboxChoice[]>('refresh_mailboxes', { account }),
  syncMailbox: (id: number, older = false) =>
    invoke<{ considered: number; stored: number; skipped: number }>('sync_mailbox', { id, older }),
  changeMessage: (location: MailLocation, action: MailboxAction, target?: number) =>
    invoke<string | null>('change_mailbox_message', { location, action, target }),
  pinMessage: (id: number, account: number | null, pinned: boolean) => invoke<void>('pin_message', { id, account, pinned }),
  sync: (id: number) => invoke<{ considered: number; stored: number; skipped: number }>('sync_inbox', { id }),
  markRead: (id: number, account: number) => invoke<void>('mark_inbox_read', { id, account }),
  createDraft: (accountId: number | null, reply: number | null = null, mode: ComposeMode = 'reply') =>
    invoke<Draft>('create_draft', { accountId, reply, mode }),
  discardDraft: (id: number, revision: number) => invoke<void>('discard_draft', { id, revision }),
  drafts: (accountId: number | null) => invoke<Draft[]>('list_drafts', { accountId }),
  readDraft: (id: number) => invoke<Draft>('read_draft', { id }),
  saveDraft: (id: number, revision: number, fields: DraftFields) =>
    invoke<Draft>('save_draft', { id, revision, fields }),
  addDraftFile: (id: number, revision: number) => invoke<Draft | null>('attach_draft_file', { id, revision }),
  removeDraftFile: (id: number, revision: number, file: number) =>
    invoke<Draft>('remove_draft_file', { id, revision, file }),
  submit: (id: number, revision: number) => invoke<SubmitResult>('submit_draft', { id, revision }),
}
