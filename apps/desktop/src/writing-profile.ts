import { invoke } from '@tauri-apps/api/core'

export const toneLabels = {
  default: '随本次写信要求',
  formal: '正式',
  friendly: '亲切',
  direct: '直接',
} as const

export const lengthLabels = {
  default: '随本次写信要求',
  brief: '简短',
  detailed: '详细',
} as const

export interface WritingMemory {
  id: string
  text: string
  recipient: string
}

export interface WritingProfile {
  displayName: string
  role: string
  signature: string
  tone: keyof typeof toneLabels
  length: keyof typeof lengthLabels
  memories: WritingMemory[]
}

export interface WritingRecord {
  revision: number
  profile: WritingProfile
}

export function readWritingProfile(accountId: number | null) {
  return invoke<WritingRecord>('read_writing_profile', { accountId })
}

export async function saveWritingProfile(accountId: number | null, revision: number, profile: WritingProfile) {
  const saved = await invoke<WritingRecord>('save_writing_profile', { accountId, revision, profile })
  window.dispatchEvent(new CustomEvent('writingProfileChanged', { detail: accountId }))
  return saved
}

export function newMemoryId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
