import '@lofold/branding/design-options'
import logo from '@lofold/branding/logo.svg'

export interface Theme {
  id: string
  name: string
  chip: string
  scheme: 'light' | 'dark'
  surface: string
  ink: string
  tier?: string
}

declare global {
  interface Window {
    MailDesignOptions: {
      brand: { name: string; slogan: string }
      themes: Theme[]
      pick: (id: string | null) => Theme
      apply: (theme: Theme) => void
    }
  }
}

const options = window.MailDesignOptions

export const { brand, themes } = options
export { logo }

export function getTheme() {
  return options.pick(localStorage.getItem('lofold.theme'))
}

export function setTheme(id: string) {
  const theme = options.pick(id)
  options.apply(theme)
  localStorage.setItem('lofold.theme', theme.id)
  return theme
}
