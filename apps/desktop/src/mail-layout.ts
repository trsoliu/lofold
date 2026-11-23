import type { MailStyle } from './mail-safe-style'

type ReadStyle = (node: HTMLElement) => MailStyle
type TableKind = 'field' | 'data' | 'layout'
type FieldPart = 'label' | 'value'

export const mailFlowElements = 'address article aside blockquote center dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr img li main ol p pre section ul'.split(' ')
const flowElements = new Set([...mailFlowElements, 'table'])
const inlineLabelNodes = new Set('a b bdi bdo cite del em font i ins mark q s small span strong sub sup tt u wbr'.split(' '))
const percentWidths = new Set('table col colgroup td th img'.split(' '))
const columnTags = new Set(['td', 'th', 'col', 'colgroup'])
const headingTags = new Set(['div', 'p', 'span', 'strong', 'b', 'font', 'td'])
const whitespaceLabels = new Set(['span', 'b', 'strong', 'em', 'i', 'font', 'small', 'td', 'th'])
const rowLimit = 256

interface MailTable {
  kind: TableKind
  scroll: boolean
  containedScroll: boolean
  sizedLayout: boolean
}

export interface MailLayoutRegion {
  table?: MailTable
  field?: FieldPart
}

interface Decoration extends MailLayoutRegion {
  classes: string[]
  removeWidth: boolean
}

export function mailWidth(element: HTMLElement) {
  const value = element.getAttribute('width')
  if (!value) return ''
  if (/^\d{1,4}$/.test(value) && Number(value) <= 1200) return value + 'px'
  if (percentWidths.has(element.localName) && /^\d{1,3}(?:\.\d{1,3})?%$/.test(value)
    && Number(value.slice(0, -1)) <= 100) return value
  return ''
}

function compactText(node: Element) {
  // A compact label has a small tree of inline text. One direct block wrapper
  // is common in mail produced by rich-text editors.
  const wrapper = node.childElementCount === 1 ? node.firstElementChild : null
  const root = wrapper && ['div', 'p'].includes(wrapper.localName)
    && node.textContent?.trim() === wrapper.textContent?.trim() ? wrapper : node
  const children = root.querySelectorAll('*')
  if (children.length > 16 || Array.from(children).some(child => !inlineLabelNodes.has(child.localName))) return ''
  const text = node.textContent?.trim().replace(/\s+/g, ' ') || ''
  return text.length <= 40 && [...text].length <= 24 ? text : ''
}

function headerCell(cell: HTMLTableCellElement) {
  const scope = cell.getAttribute('scope')?.toLowerCase()
  return cell.localName === 'th' && scope !== 'col' && scope !== 'colgroup'
}

function repeatedFields(rows: HTMLCollectionOf<HTMLTableRowElement>, explicitColumns: boolean) {
  if (rows.length < 2 || rows.length > rowLimit) return null
  const pairs: Array<[HTMLTableCellElement, HTMLTableCellElement]> = []
  let cues = 0, namedFields = 0
  for (const row of rows) {
    // A full-width title, status separator, or footer can belong to the same
    // table as label/value rows. It retains its span and never counts as a pair.
    const first = row.cells[0]
    if (row.cells.length === 1 && first.colSpan === 2 && first.rowSpan === 1
      && (first.localName === 'td' || headerCell(first))) continue
    if (row.cells.length !== 2) return null
    const [label, value] = Array.from(row.cells)
    if (row.parentElement?.localName === 'thead' || value.localName !== 'td'
      || (label.localName === 'th' && !headerCell(label))
      || [label, value].some(cell => cell.rowSpan !== 1 || cell.colSpan !== 1 || cell.hidden)) return null
    const text = compactText(label)
    if (!text || (!value.textContent?.trim() && !value.querySelector('img,video,table,dl'))) return null
    const namedField = /[:：]$/.test(text)
    if (namedField) namedFields++
    if (headerCell(label) || namedField) cues++
    pairs.push([label, value])
  }
  // Avoid treating side-by-side newsletter cards or a plain two-column dataset
  // as a description list merely because their first cells are short.
  return cues >= 2 && cues * 2 >= pairs.length && (!explicitColumns || namedFields >= 2) ? pairs : null
}

function definitionPairs(element: HTMLElement) {
  if (element.children.length < 4 || element.children.length > rowLimit * 2 || element.children.length % 2) return null
  const pairs: Array<[HTMLElement, HTMLElement]> = []
  for (let index = 0; index < element.children.length; index += 2) {
    const label = element.children[index]
    const value = element.children[index + 1]
    if (!(label instanceof HTMLElement) || !(value instanceof HTMLElement)
      || label.localName !== 'dt' || value.localName !== 'dd' || !compactText(label)) return null
    pairs.push([label, value])
  }
  return pairs
}

function fieldRows(element: HTMLElement) {
  if (element.children.length < 2 || element.children.length > rowLimit) return null
  const rows: Array<[HTMLElement, HTMLElement, HTMLElement]> = []
  if (!['div', 'section', 'article'].includes(element.localName)
    || Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return null
  for (const row of element.children) {
    if (!(row instanceof HTMLElement) || row.localName !== 'div' || row.children.length !== 2) return null
    const [label, value] = Array.from(row.children)
    if (!(label instanceof HTMLElement) || !(value instanceof HTMLElement)
      || !/[:：]$/.test(compactText(label)) || !value.textContent?.trim()
      || Array.from(row.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return null
    rows.push([row, label, value])
  }
  return rows
}

function singleColumnLayout(table: HTMLTableElement) {
  // The common one-cell newsletter wrapper carries content, not columns.
  if (table.caption || table.tHead || !table.rows.length || table.rows.length > rowLimit) return false
  for (const row of table.rows) {
    if (row.cells.length !== 1 || row.cells[0].localName !== 'td'
      || row.cells[0].rowSpan !== 1 || row.cells[0].colSpan !== 1) return false
  }
  return true
}

function compactHeading(node: HTMLElement, style: MailStyle) {
  const size = /^(\d+(?:\.\d+)?)px$/.exec(style.properties.get('font-size') || '')
  const heading = /^h[1-6]$/.test(node.localName) || (size !== null && Number(size[1]) >= 19 && headingTags.has(node.localName))
  const text = heading ? compactText(node) : ''
  return text.length <= 24 && [...text].length <= 12 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
}

export function mailLayout(read: ReadStyle) {
  const marks = new WeakMap<HTMLElement, string>()
  function markFields(pairs: Array<[HTMLElement, HTMLElement]>) {
    for (const [label, value] of pairs) {
      marks.set(label, 'mail-field-label')
      marks.set(value, 'mail-field-value')
    }
  }
  function tableKind(table: HTMLTableElement, singleColumn: boolean): TableKind {
    const role = table.getAttribute('role')?.toLowerCase()
    const layout = singleColumn || role === 'presentation' || role === 'none'
    // A caption and explicit columns also describe ordinary row-header data.
    const explicitColumns = !!table.caption && Array.from(table.children).some(child => child.localName === 'colgroup')
    const pairs = repeatedFields(table.rows, explicitColumns)
    const kind = pairs ? 'field' : layout ? 'layout' : 'data'
    if (pairs) markFields(pairs)
    return kind
  }

  return (node: HTMLElement, parent: MailLayoutRegion, style: MailStyle): Decoration => {
    const classes: string[] = []
    let table = parent.table
    let field = parent.field
    if (node instanceof HTMLTableElement) {
      const singleColumn = singleColumnLayout(node)
      const kind = tableKind(node, singleColumn)
      const width = style.properties.get('width') || mailWidth(node)
      table = {
        kind,
        scroll: !parent.table || kind === 'data',
        // A single-column shell can take the reading width when a nested
        // data table scrolls, without disturbing auto-sized multicolumn layouts.
        containedScroll: !!parent.table?.sizedLayout && kind === 'data',
        sizedLayout: kind === 'field' || (kind === 'layout' && (singleColumn || parseFloat(width) > 0)),
      }
      field = undefined
      classes.push(kind === 'field' ? 'mail-field-table' : kind === 'layout' ? 'mail-layout-table' : 'mail-data-table')
      if (kind === 'layout' && singleColumn) classes.push('mail-layout-shell')
    } else if (node.localName === 'dl') {
      const pairs = definitionPairs(node)
      if (pairs) {
        classes.push('mail-field-list')
        markFields(pairs)
      }
    } else {
      const rows = fieldRows(node)
      if (rows) {
        classes.push('mail-field-group')
        for (const [row, label, value] of rows) {
          marks.set(row, 'mail-field-row')
          markFields([[label, value]])
        }
      }
    }
    const mark = marks.get(node)
    if (mark) classes.push(mark)
    if (mark === 'mail-field-label') field = 'label'
    if (mark === 'mail-field-value') field = 'value'
    const compactColumn = !field && table?.kind === 'data' && node.localName === 'th' && !!compactText(node)
    if (compactColumn) {
      classes.push('mail-column-label')
      field = 'label'
    }
    if (!field && table?.kind === 'layout' && !node.closest('th,pre,code') && compactHeading(node, style)) classes.push('mail-layout-heading')
    const removeWidth = (field === 'label' && !compactColumn) || mark === 'mail-field-value' || mark === 'mail-field-row'
      || classes.includes('mail-field-group') || classes.includes('mail-field-list')
      || (table?.kind === 'field' && (node.localName === 'table' || columnTags.has(node.localName)))
    return { table, field, classes, removeWidth }
  }
}

export function fitMailStyle(
  node: HTMLElement, style: MailStyle, properties: Map<string, string>, layout: Decoration, widthAttribute: string, read: ReadStyle,
) {
  const tag = node.localName
  const nowrap = properties.get('white-space') === 'nowrap'
  if (layout.field === 'label') {
    properties.delete('white-space')
    if (layout.classes.includes('mail-field-label') || layout.classes.includes('mail-column-label')) {
      // Keep native table-cell display and the project-owned field layout.
      properties.delete('display')
    } else if (inlineLabelNodes.has(tag)) properties.delete('display')
  } else if (nowrap) {
    if (node.closest('pre')) properties.set('white-space', 'pre-wrap')
    else if (layout.field === 'value' || !whitespaceLabels.has(tag) || (node.textContent?.trim().length ?? 0) > 48) {
      properties.set('white-space', 'normal')
    }
  }
  if (layout.classes.some(name => name === 'mail-field-group' || name === 'mail-field-list' || name === 'mail-field-row'
    || name === 'mail-field-value' || name === 'mail-field-table' || name === 'mail-data-table' || name === 'mail-layout-table')) {
    properties.delete('display')
  }
  if (layout.removeWidth) {
    properties.delete('width')
    properties.delete('max-width')
    return
  }

  // Some legacy newsletters float a zero-width wrapper and give its child an
  // independent width. We drop float, so keep that wrapper from reducing every
  // responsive descendant to zero width, while preserving hidden spacers.
  if (tag === 'div' && (properties.get('width') || widthAttribute) === '0px'
    && /^(left|right)$/.test(style.float) && !/^(hidden|clip)$/.test(style.overflow)
    && Array.from(node.children).some(child => {
      if (!(child instanceof HTMLElement) || child.hidden) return false
      const childStyle = read(child).properties
      const width = childStyle.get('width') || mailWidth(child)
      return childStyle.get('display') !== 'none' && /(?:px|pt|em|rem)$/.test(width) && parseFloat(width) > 0
    })) {
    properties.set('width', 'auto')
    return
  }

  if (tag === 'table' && layout.table?.kind === 'data') return
  if (!flowElements.has(tag) && !/^(?:block|inline-block)$/.test(properties.get('display') || '')) return
  const max = properties.get('max-width')
  if (max) properties.set('max-width', 'min(100%,' + max + ')')
  // For presentation tables and picture boxes the authored size is preferred
  // when it fits. Wide data tables instead keep a local scroll region.
  const width = properties.get('width') || widthAttribute
  if (width && (tag === 'table' || tag === 'img' || properties.get('display') === 'inline-block')) {
    properties.set('width', 'min(100%,' + width + ')')
  }
}
