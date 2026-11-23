import { themes, type Theme } from './branding'
import { ControlSelect } from './controls'
import type { AccountChoice } from './mail-workspace'
import type { Screen } from './mailbox-navigation'
import { WritingSettings } from './writing-settings'

const senderKey = 'lofold.defaultSender'

export function getDefaultSender() {
  const stored = Number(localStorage.getItem(senderKey))
  return Number.isSafeInteger(stored) && stored > 0 ? stored : null
}

export function saveDefaultSender(account: number | null) {
  if (account === null) localStorage.removeItem(senderKey)
  else localStorage.setItem(senderKey, String(account))
}

type Props = {
  section: 'settings' | 'appearance'
  theme: Theme
  changeTheme: (id: string) => void
  accounts: AccountChoice[]
  defaultSender: number | null
  changeDefault: (account: number | null) => void
}

const categories = [
  { id: 'accounts', label: '邮箱账号' },
  { id: 'settings', label: '写信' },
  { id: 'ai-settings', label: '大模型' },
  { id: 'appearance', label: '外观' },
  { id: 'offline', label: '本机存储' },
  { id: 'agent-mcp', label: 'Agent MCP' },
] as const

export function isSettingsScreen(screen: Screen) {
  return categories.some((item) => item.id === screen)
}

export function SettingsHeader({ screen, navigate }: { screen: Screen; navigate: (screen: Screen) => void }) {
  return <header className="settings-header">
    <h1>设置</h1>
    <nav className="settings-navigation" aria-label="设置分类">
      {categories.filter(({ id }) => id !== 'agent-mcp' || navigator.platform.startsWith('Mac')).map(({ id, label }) => <button className="secondary" type="button" key={id}
        aria-current={id === screen ? 'page' : undefined} onClick={() => navigate(id)}>{label}</button>)}
    </nav>
  </header>
}

export function Settings({ section, theme, changeTheme, accounts, defaultSender, changeDefault }: Props) {
  const connected = accounts.filter((account) => account.connected)
  const activeDefault = connected.some((account) => account.id === defaultSender) ? defaultSender : null

  return <section className="account-page" aria-label={section === 'appearance' ? '外观' : '写信'}>
    <div className="account-content settings-content">
      {section === 'appearance'
        ? <div className="settings-section">
          <label className="settings-field">
            <span>外观主题</span>
            <span className="theme-control">
              <ControlSelect value={theme.id} onChange={(event) => changeTheme(event.target.value)}>
                {themes.map((item) => <option value={item.id} key={item.id}>{item.name}{item.tier ? ' · 尊享' : ''}</option>)}
              </ControlSelect>
              <span className="theme-swatch" aria-hidden="true" style={{ backgroundColor: theme.chip }} />
            </span>
          </label>
        </div>
        : <>
          <div className="settings-section">
            <label className="settings-field">
              <span>默认发件邮箱</span>
              <ControlSelect value={activeDefault ?? ''} disabled={!connected.length}
                onChange={(event) => changeDefault(event.target.value ? Number(event.target.value) : null)}>
                <option value="">{connected.length > 1 ? '写信时选择' : connected.length ? '自动选择' : '暂无已授权邮箱'}</option>
                {connected.map((account) => <option value={account.id} key={account.id}>{account.address}</option>)}
              </ControlSelect>
            </label>
            <p className="muted">从汇总视图写新邮件时使用此邮箱。</p>
          </div>
          <WritingSettings accounts={accounts} initialAccount={activeDefault ?? (connected.length === 1 ? connected[0].id : null)} />
        </>}
    </div>
  </section>
}
