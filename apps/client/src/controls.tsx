import { ChevronDown, type LucideIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

type SelectProps = ComponentProps<'select'>

export function ControlSelect({ className, ...props }: SelectProps) {
  return <span className={className ? 'control-select ' + className : 'control-select'}>
    <select {...props} />
    <ChevronDown size={14} className="select-chevron" aria-hidden="true" />
  </span>
}

type ActionProps = Omit<ComponentProps<'button'>, 'children'> & {
  icon: LucideIcon
  label: string
}

export function IconAction({ icon: Icon, label, className, title = label, ...props }: ActionProps) {
  return <button type="button" {...props} className={className ? 'secondary icon-action ' + className : 'secondary icon-action'}
    aria-label={label} title={title}>
    <Icon size={16} aria-hidden="true" />
  </button>
}
