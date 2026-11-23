import type { WritingProfile } from './writing-profile'

// Drafts and SMTP use bare mailbox addresses. Never extract a contact from a list or a display name.
export function soleRecipient(to: string, cc: string, bcc: string): string | null {
  if (cc.trim() || bcc.trim() || /[,;，；\u0000-\u001f\u007f]/u.test(to)) return null
  const address = to.trim()
  const at = address.lastIndexOf('@')
  if (at < 1 || new TextEncoder().encode(address).length > 254) return null
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  const simple = /^[^\s<>@:"()\[\]\\]+$/u.test(local) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
  const quoted = /^"(?:[^"\\]|\\.)+"$/u.test(local)
  if ((!simple && !quoted) || !domain.split('.').every(label => /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u.test(label))) return null
  return local + '@' + domain.toLowerCase()
}

export function applicableMemories(profile: WritingProfile, recipient: string, cc: string, bcc: string) {
  const target = soleRecipient(recipient, cc, bcc)
  return profile.memories.filter(memory => !memory.recipient || (target !== null && soleRecipient(memory.recipient, '', '') === target))
}
