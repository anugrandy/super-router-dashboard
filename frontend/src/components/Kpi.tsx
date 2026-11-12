import type { CSSProperties, ReactNode } from 'react'

export type KpiTone = 'default' | 'green' | 'red' | 'muted'

export type KpiItem = {
  label: string
  value: ReactNode
  /** Optional second line: what the figure refers to, or a small breakdown. */
  sub?: ReactNode
  tone?: KpiTone
}

const toneClass: Record<KpiTone, string> = {
  default: '',
  green: 'kpi-value-green',
  red: 'kpi-value-red',
  muted: 'kpi-value-muted',
}

/**
 * One continuous strip for passive summary figures. Replaces the old grid of
 * bordered stat cards: figures sit on the page itself, separated by 1px rules.
 * The strip folds to two columns on phones so numbers stay readable.
 */
export default function KpiStrip({
  items,
  className = '',
  mobileCols = 2,
}: {
  items: KpiItem[]
  className?: string
  /** Phones use two columns unless a short strip reads better stacked. */
  mobileCols?: 1 | 2
}) {
  return (
    <dl
      className={`kpi-strip ${mobileCols === 1 ? 'kpi-strip-stacked' : ''} ${className}`.trim()}
      style={
        {
          '--kpi-cols': String(Math.min(items.length, 4)),
        } as CSSProperties
      }
    >
      {items.map((item) => (
        <div key={item.label} className="kpi-cell">
          <dt className="kpi-label">{item.label}</dt>
          <dd className={`kpi-value ${toneClass[item.tone ?? 'default']}`}>
            {item.value}
            {item.sub && <div className="kpi-sub">{item.sub}</div>}
          </dd>
        </div>
      ))}
    </dl>
  )
}
