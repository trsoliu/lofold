import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from './archive'
import { ControlSelect } from './controls'

type ImageAccounts = {
  linked: boolean
  accounts: { id: number; address: string }[]
}

export function imageAccounts(id: number) {
  return invoke<ImageAccounts>('message_image_accounts', { id })
}

export function WatermarkAccountDialog({ choices, close, save }: {
  choices: ImageAccounts
  close: () => void
  save: (account: number | null) => void
}) {
  const modal = useRef<HTMLDialogElement>(null)
  const [account, setAccount] = useState(choices.accounts.length === 1 ? String(choices.accounts[0].id) : '')
  const hasAccounts = choices.accounts.length > 0

  useEffect(() => {
    const dialog = modal.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  }, [])

  return <dialog className="mail-action-dialog" ref={modal} aria-labelledby="watermark-account-title"
    onCancel={(event) => { event.preventDefault(); close() }}>
    <form onSubmit={(event) => {
      event.preventDefault()
      if (hasAccounts && !account) return
      save(hasAccounts ? Number(account) : null)
    }}>
      <h2 id="watermark-account-title">{hasAccounts ? '选择暗水印账号' : '保存无暗水印的长图'}</h2>
      <p className="muted">{!hasAccounts ? '请先添加邮箱账号，才能给长图加上账号暗水印。'
        : choices.linked ? '这封邮件关联多个邮箱，请选择用于本次导出的账号。'
        : '这封邮件未关联邮箱，请选择用于本次导出的账号。'}</p>
      {hasAccounts && <label>邮箱账号
        <ControlSelect autoFocus required value={account} onChange={(event) => setAccount(event.target.value)}>
          <option value="">请选择</option>
          {choices.accounts.map((item) => <option key={item.id} value={item.id}>{item.address}</option>)}
        </ControlSelect>
      </label>}
      <div className="account-actions">
        <button className="secondary" type="button" onClick={close} autoFocus={!hasAccounts}>取消</button>
        <button className="secondary" disabled={hasAccounts && !account}>{hasAccounts ? '继续保存' : '保存无水印长图'}</button>
      </div>
    </form>
  </dialog>
}

export function WatermarkReader() {
  const [reading, setReading] = useState(false)
  const [result, setResult] = useState<{ address: string | null } | null>(null)
  const [error, setError] = useState('')

  async function read() {
    setReading(true)
    setResult(null)
    setError('')
    try {
      const watermark = await invoke<{ address: string | null } | null>('read_image_watermark')
      if (watermark) setResult(watermark)
    } catch (issue) {
      setError(errorMessage(issue))
    } finally {
      setReading(false)
    }
  }

  return <div className="watermark-reader">
    <button type="button" className="secondary" disabled={reading} aria-busy={reading} onClick={() => void read()}>
      {reading ? '正在读取暗水印' : '读取长图暗水印'}
    </button>
    {result && <p className="account-notice" role="status">{result.address
      ? <>暗水印账号 <bdi>{result.address}</bdi></>
      : '未检测到本机可验证的暗水印。'}</p>}
    {error && <p className="account-notice" role="alert">{error}</p>}
  </div>
}
