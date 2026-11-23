import { invoke } from '@tauri-apps/api/core'
import type { Folder, MailLocation } from './mail-workspace'

export const MAX_EML_BYTES = 16 * 1024 * 1024

export interface MailSummary {
  id: number
  subject: string
  sender: string
  preview: string
  sentAt: number | null
  hasAttachments: boolean
  accountId?: number | null
  accountAddress?: string | null
  unread?: boolean
  flagged?: boolean
  pinned?: boolean
  location?: MailLocation | null
}

export interface MailPage {
  items: MailSummary[]
  hasMore: boolean
}

export interface MailConversation {
  items: MailSummary[]
  hasMore: boolean
  indexingPending: boolean
}

export interface InlineMailVideo {
  ordinal: number
  mime: 'video/mp4' | 'video/webm'
}

export interface MailDetail extends MailSummary {
  recipients: string
  body: string
  bodyTruncated: boolean
  richBody?: { html: string; inlineImages: Record<string, string>; inlineVideos?: Record<string, InlineMailVideo> } | null
  attachments: { index: number; name: string; size: number }[]
}

export const archive = {
  list: (query: string, offset = 0, folder: Folder = 'archive', account: number | null = null, attachmentsOnly = false, mailbox: number | null = null) =>
    invoke<MailPage>('list_mail', { query, offset, folder, account, attachmentsOnly, mailbox }),
  read: (id: number) => invoke<MailDetail>('read_mail', { id }),
  conversation: (id: number, account: number | null) => invoke<MailConversation>('read_conversation', { id, account }),
  import: async (file: File) => {
    if (file.size > MAX_EML_BYTES) throw new Error('每封 EML 最大支持 16 MiB。')
    return invoke<{ id: number; duplicate: boolean }>('import_eml', await file.arrayBuffer())
  },
  save: (id: number, attachmentIndex?: number) =>
    invoke<boolean>('save_mail', { id, attachmentIndex: attachmentIndex ?? null }),
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '操作失败，请重试。'
}
