import { useId, useRef, useState, type FormEvent } from 'react'
import { ControlSelect } from './controls'
import type { MailServer, ServerSettings } from './mail-workspace'

type Protocol = 'imap' | 'smtp'

const ports = { imap: [993, 143], smtp: [465, 587] } as const
const protocols = ['imap', 'smtp'] as const

function defaultServers(address: string): ServerSettings {
  return {
    imap: { host: '', port: ports.imap[0], username: address, startTls: false },
    smtp: { host: '', port: ports.smtp[0], username: address, startTls: false },
  }
}

type Props = {
  address: string
  saved: ServerSettings | null
  busy: boolean
  notice: { text: string; error?: boolean } | null
  save: (servers: ServerSettings, authorization?: string) => void
  close: () => void
}

export function ServerForm({ address, saved, busy, notice, save, close }: Props) {
  const [initial] = useState(() => saved ?? defaultServers(address))
  const [modes, setModes] = useState({ imap: initial.imap.startTls, smtp: initial.smtp.startTls })
  const [port, setPort] = useState({ imap: String(initial.imap.port), smtp: String(initial.smtp.port) })
  const [missingPassword, setMissingPassword] = useState(false)
  const passwordInput = useRef<HTMLInputElement>(null)
  const passwordHelp = useId()
  const passwordError = useId()

  function updateMode(protocol: Protocol, startTls: boolean) {
    const oldPort = ports[protocol][modes[protocol] ? 1 : 0]
    if (port[protocol] === String(oldPort)) {
      setPort((current) => ({ ...current, [protocol]: String(ports[protocol][startTls ? 1 : 0]) }))
    }
    setModes((current) => ({ ...current, [protocol]: startTls }))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = passwordInput.current
    if (!input || busy) return
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    const offline = submitter instanceof HTMLButtonElement && submitter.value === 'offline'
    const authorization = offline ? undefined : input.value
    if (authorization !== undefined && !authorization.trim()) {
      setMissingPassword(true)
      input.focus()
      return
    }
    const values = new FormData(event.currentTarget)
    function server(protocol: Protocol): MailServer {
      return {
        host: String(values.get(protocol + '-host') ?? '').trim(),
        port: Number(port[protocol]),
        username: String(values.get(protocol + '-user') ?? '').trim(),
        startTls: modes[protocol],
      }
    }
    input.value = ''
    setMissingPassword(false)
    save({ imap: server('imap'), smtp: server('smtp') }, authorization)
  }

  return <form className="server-form" aria-label="服务器配置" onSubmit={submit}>
    <p className="muted">请使用邮箱服务商或管理员提供的服务器参数。</p>
    <div className="server-fields">
      {protocols.map((protocol) => {
        const label = protocol.toUpperCase()
        return <fieldset className="server-fields-group" key={protocol} disabled={busy}>
          <legend>{protocol === 'imap' ? '收件服务器 · IMAP' : '发件服务器 · SMTP'}</legend>
          <label className="server-field server-wide">主机名
            <input aria-label={label + ' 主机名'} name={protocol + '-host'} autoComplete="off"
              defaultValue={initial[protocol].host} required maxLength={253} spellCheck={false} />
          </label>
          <label className="server-field">端口
            <input aria-label={label + ' 端口'} type="number" min={1} max={65535} required
              value={port[protocol]} onChange={(event) => setPort((current) => ({ ...current, [protocol]: event.target.value }))} />
          </label>
          <label className="server-field">加密方式
            <ControlSelect aria-label={label + ' 加密方式'} value={modes[protocol] ? 'starttls' : 'tls'}
              onChange={(event) => updateMode(protocol, event.target.value === 'starttls')}>
              <option value="tls">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
            </ControlSelect>
          </label>
          <label className="server-field server-wide">登录名
            <input aria-label={label + ' 登录名'} name={protocol + '-user'} autoComplete="off"
              defaultValue={initial[protocol].username} maxLength={254} spellCheck={false} required />
          </label>
        </fieldset>
      })}
    </div>
    <label className="server-field server-password">客户端密码
      <input type="password" autoComplete="off" maxLength={256} ref={passwordInput} disabled={busy}
        aria-invalid={missingPassword} aria-describedby={missingPassword ? passwordHelp + ' ' + passwordError : passwordHelp}
        onInput={() => setMissingPassword(false)} />
    </label>
    <p className="muted" id={passwordHelp}>验证通过后将密码存入本机受保护的凭据存储。仅保存服务器时可留空。</p>
    {missingPassword && <p className="account-notice" role="alert" id={passwordError}>请输入客户端密码。</p>}
    <div className="account-actions">
      <button className="secondary server-verify" type="submit" disabled={busy}>保存并验证</button>
      <button className="secondary" type="submit" value="offline" disabled={busy}>仅保存服务器</button>
      <button className="secondary" type="button" disabled={busy} onClick={close}>取消</button>
      {notice && !missingPassword && <p className="account-notice" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    </div>
  </form>
}
