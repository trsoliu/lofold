const colors = new Set(['color', 'background-color', 'border-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color'])
const enums: Record<string, RegExp> = {
  'display': /^(?:none|block|inline|inline-block)$/,
  'background-size': /^(?:cover|contain|100%|100% auto)$/,
  'background-position': /^(?:(?:left|right|center|top|bottom|0%|50%|100%)(?: (?:left|right|center|top|bottom|0%|50%|100%))?)$/,
  'background-repeat': /^(?:no-repeat|repeat|repeat-x|repeat-y)$/,
  'text-align': /^(left|right|center|justify|start|end)$/,
  'vertical-align': /^(baseline|middle|top|bottom|sub|super|text-top|text-bottom)$/,
  'font-weight': /^(normal|bold|bolder|lighter|[1-9]00)$/,
  'font-style': /^(normal|italic|oblique)$/,
  'white-space': /^(normal|nowrap|pre-wrap|pre-line|break-spaces)$/,
  'text-decoration-line': /^(none|underline|line-through|overline)( (underline|line-through|overline))*$/,
  'list-style-type': /^(none|disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)$/,
  'border-collapse': /^(collapse|separate)$/,
}
const edges = ['top', 'right', 'bottom', 'left']
const cssProps = [...colors, ...Object.keys(enums), 'font-size', 'line-height', 'width', 'max-width',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  ...edges.flatMap(side => ['padding-' + side, 'margin-' + side, 'border-' + side + '-style', 'border-' + side + '-width'])]
const color = /^(?:#[a-f\d]{3,8}|[a-z]{1,20}|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/]+\))$/i
function cssValue(prop: string, value: string) {
  if (colors.has(prop)) return color.test(value)
  if (enums[prop]) return enums[prop].test(value)
  if (value === 'auto' && /^margin-(left|right)$/.test(prop)) return true
  if (prop.endsWith('-style')) return /^(solid|dashed|dotted|double|none)$/.test(value)
  const unit = /^(\d+(?:\.\d+)?)(px|pt|em|rem|%)?$/.exec(value)
  if (!unit) return prop === 'font-size' && /^(small|medium|large|x-small|x-large|xx-large)$/.test(value)
  const amount = Number(unit[1])
  if (prop === 'line-height') {
    if (unit[2] === '%') return amount >= 80 && amount <= 300
    if (unit[2] === 'px' || unit[2] === 'pt') return amount >= 8 && amount <= 80
    return amount >= .8 && amount <= 3
  }
  if (prop.endsWith('-radius') && unit[2] === '%') return amount <= 50
  if (!unit[2]) return amount === 0
  const width = prop.endsWith('width') && !prop.startsWith('border')
  if (unit[2] === '%') return amount <= (prop === 'font-size' ? 250 : width ? 100 : 8)
  if (unit[2] === 'em' || unit[2] === 'rem') return amount <= (width ? 80 : 3)
  return amount <= (width ? 1200 : prop.startsWith('border') ? 8 : 72)
}

function declarations(style: CSSStyleDeclaration) {
  const css: string[] = []
  for (const prop of cssProps) {
    const value = style.getPropertyValue(prop)
    if (value && cssValue(prop, value)) css.push(prop + ':' + value)
  }
  return css.join(';')
}

// Inspect top-level rules only. Media queries, imports, keyframes, fonts and
// quoted CSS data are never evaluated in an active document.
function* flatRules(source: string) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  let start = 0, open = 0, depth = 0, quote = '', nested = false
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === ';' && depth === 0) start = i + 1
    else if (c === '{') {
      if (depth++ === 0) { open = i; nested = false }
      else nested = true
    } else if (c === '}' && depth > 0 && --depth === 0) {
      const selector = css.slice(start, open).trim()
      if (!nested && selector && !selector.startsWith('@')) yield [selector, css.slice(open + 1, i)]
      start = i + 1
    }
  }
}

// Preserve common class-based newsletter formatting. Complex selectors, at-rules
// and resource-bearing properties never enter the document we display.
function stylesheetDeclarations(fragment: DocumentFragment) {
  const rules: Array<{ selector: string; style: AuthoredStyle; weight: number }> = []
  const token = /^(?:[a-z][a-z0-9-]*)?(?:[.#][a-z_][a-z0-9_-]*){0,3}$/i
  const parsed = document.createElement('span').style
  let cssBytes = 0
  for (const sheet of fragment.querySelectorAll('style')) {
    const source = sheet.textContent || ''
    cssBytes += source.length
    if (cssBytes > 128_000) break
    for (const [selectors, body] of flatRules(source)) {
      parsed.cssText = body
      const style = authoredStyle(parsed)
      if (!style.css && !style.background && !style.float && !style.overflow && !style.height) continue
      for (const entry of selectors.split(',')) {
        const selector = entry.trim()
        const segments = selector.split(/\s+/)
        if (!selector || selector.length > 120 || segments.length > 3 || !segments.every(piece => token.test(piece))) continue
        const weight = (selector.match(/#/g)?.length ?? 0) * 100 + (selector.match(/\./g)?.length ?? 0) * 10
          + segments.filter(piece => /^[a-z]/i.test(piece)).length
        rules.push({ selector, style, weight })
        if (rules.length === 96) break
      }
      if (rules.length === 96) break
    }
    if (rules.length === 96) break
  }
  const styles = new WeakMap<Element, AuthoredStyle>()
  let matches = 0
  for (const rule of rules.sort((a, b) => a.weight - b.weight)) {
    for (const element of fragment.querySelectorAll(rule.selector)) {
      if (++matches > 32_000) return styles
      const previous = styles.get(element)
      const css = [previous?.css, rule.style.css].filter(Boolean).join(';')
      styles.set(element, {
        css: css.length <= 2500 ? css : previous?.css || '',
        background: rule.style.background || previous?.background || '',
        float: rule.style.float || previous?.float || '',
        overflow: rule.style.overflow || previous?.overflow || '',
        height: rule.style.height || previous?.height || '',
      })
    }
  }
  return styles
}

interface AuthoredStyle {
  css: string
  background: string
  float: string
  overflow: string
  height: string
}

function authoredStyle(style: CSSStyleDeclaration): AuthoredStyle {
  return {
    css: declarations(style),
    background: style.backgroundImage,
    float: style.cssFloat,
    overflow: style.overflowX,
    height: style.height,
  }
}

export interface MailStyle {
  readonly properties: ReadonlyMap<string, string>
  readonly background: string
  readonly float: string
  readonly overflow: string
  readonly height: string
}

// Class selectors are applied in bounded specificity order. Legacy attributes
// provide defaults and valid inline declarations take precedence. Resource and
// layout hints are carried separately and never written as sender CSS.
export function mailStyles(fragment: DocumentFragment) {
  const classStyles = stylesheetDeclarations(fragment)
  const scratch = document.createElement('div').style
  const cached = new WeakMap<HTMLElement, MailStyle>()
  return (element: HTMLElement): MailStyle => {
    const prior = cached.get(element)
    if (prior) return prior
    const classes = classStyles.get(element)
    const inline = authoredStyle(element.style)
    const legacy = []
    for (const [attr, prop] of [['bgcolor', 'background-color'], ['color', 'color'], ['align', 'text-align'], ['valign', 'vertical-align']]) {
      const value = element.getAttribute(attr)?.toLowerCase()
      if (value && cssValue(prop, value)) legacy.push(prop + ':' + value)
    }
    scratch.cssText = [...legacy, classes?.css, inline.css].filter(Boolean).join(';')
    const properties = new Map<string, string>()
    for (const prop of cssProps) {
      const value = scratch.getPropertyValue(prop)
      if (value && cssValue(prop, value)) properties.set(prop, value)
    }
    const style = {
      properties,
      background: inline.background || classes?.background || '',
      float: inline.float || classes?.float || '',
      overflow: inline.overflow || classes?.overflow || '',
      height: inline.height || classes?.height || '',
    }
    cached.set(element, style)
    return style
  }
}
