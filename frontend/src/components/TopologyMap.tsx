import { memo, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { Device } from '../api'
import { DeviceChip } from './icons'
import { Router } from 'lucide-react'
import { displayName } from '../api'

/**
 * Network topology, drawn as a plain SVG.
 *
 * Performance notes, since this page was added right after a lag fix:
 *
 * - **No graph library and no physics.** react-force-graph/d3-force run a
 *   simulation every frame, which pins CPU/GPU while idle. This layout is
 *   computed once with `useMemo` from a stable key, so the graph never moves
 *   and never re-simulates.
 * - **Rows are memoized.** Each node is its own `memo` component keyed by MAC
 *   with primitive-ish props, so a status change on one device does not
 *   re-render the other nine - the same fix applied to the device table.
 * - **The node set is a string key.** `useMemo` depends on the sorted MAC list,
 *   so an unrelated WebSocket push that does not change membership leaves the
 *   layout untouched.
 */

const W = 900
const H = 560
const CX = W / 2
const CY = H / 2
const R_OUTER = 210

type Props = { devices: Device[]; routerName: string; gatewayMac: string }

/** Radial layout: one ring of clients around the router. */
function layout(count: number) {
  if (count <= 0) return []
  return Array.from({ length: count }, (_, i) => {
    // Start at -90deg so the first node sits at the top, then spread evenly.
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2
    return {
      x: CX + Math.cos(angle) * R_OUTER,
      y: CY + Math.sin(angle) * R_OUTER,
      angle,
    }
  })
}

/**
 * One client node. Memoized: only re-renders when its own fields change.
 * `band` is split from the device object so an unchanged row keeps identity.
 */
const Node = memo(function Node({
  d,
  x,
  y,
}: {
  d: Device
  x: number
  y: number
}) {
  const offline = !d.online
  const kicked = d.kicked != null
  const label = displayName(d)

  return (
    <g transform={`translate(${x} ${y})`}>
      <Link to={`/devices/${encodeURIComponent(d.mac)}`}>
        {/* Generous invisible hit area: the 32px chip alone is hard to click. */}
        <circle r={30} fill="transparent" />
        <circle
          r={17}
          fill={kicked ? 'rgba(239,68,68,0.12)' : 'var(--color-surface)'}
          stroke={kicked ? '#EF4444' : 'var(--color-border)'}
          strokeWidth={kicked ? 2 : 1}
          // Dashed ring marks a device that is being blocked.
          strokeDasharray={kicked ? '4 3' : undefined}
          opacity={offline ? 0.4 : 1}
        />
        {/* Filled dot = online, hollow = offline. A real shape rather than a
            text glyph, so it renders identically in every font. */}
        <circle
          cy={-2}
          r={5}
          fill={offline ? 'none' : '#22C55E'}
          stroke={offline ? '#8F8F8F' : 'none'}
          strokeWidth={1.5}
          opacity={offline ? 0.8 : 1}
          style={{ pointerEvents: 'none' }}
        />
        <text
          y={34}
          textAnchor="middle"
          fontSize={11}
          fill="#8F8F8F"
          opacity={offline ? 0.7 : 1}
          style={{ pointerEvents: 'none' }}
        >
          {label.length > 16 ? `${label.slice(0, 15)}…` : label}
        </text>
        <text
          y={46}
          textAnchor="middle"
          fontSize={10}
          fill="#525252"
          fontFamily="Geist Mono, monospace"
          style={{ pointerEvents: 'none' }}
        >
          {d.ip || d.mac}
        </text>
      </Link>
    </g>
  )
})

export default function TopologyMap({ devices, routerName, gatewayMac }: Props) {
  const { t } = useTranslation()
  // The router is the hub; clients are the rest. Derive membership from MACs so
  // an unrelated state update cannot invalidate the layout memo.
  const clients = useMemo(
    () => devices.filter((d) => d.mac !== gatewayMac),
    [devices, gatewayMac],
  )
  const layoutKey = useMemo(
    () => clients.map((d) => d.mac).sort().join(','),
    [clients],
  )
  const positions = useMemo(
    () => layout(clients.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  )

  // On a phone the SVG is wider than the viewport. Start centred on the router
  // hub rather than on the empty left edge of the ring.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  }, [layoutKey])

  const online = clients.filter((d) => d.online).length
  const kicked = clients.filter((d) => d.kicked != null).length

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="card-title">{t('topologyMap.title')}</h2>
          <p className="card-sub mt-0.5">
            {t('topologyMap.summary', { online, offline: clients.length - online })}
            {kicked > 0 ? t('topologyMap.kicked', { n: kicked }) : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#22C55E' }} />
            {t('topologyMap.online')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#525252' }} />
            {t('topologyMap.offline')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{
                background: 'rgba(239,68,68,0.2)',
                border: '1px dashed #EF4444',
              }}
            />
            {t('topologyMap.kickedLabel')}
          </span>
        </div>
      </div>

      <p className="mb-2 text-[11px] text-muted2 sm:hidden">
        {t('topologyMap.scrollHint')}
      </p>

      <div ref={scroller} className="-mx-5 overflow-x-auto px-5">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full min-w-[680px]"
          style={{ maxHeight: 560 }}
          role="img"
          aria-label={t('topologyMap.aria')}
        >
          {/* Links first so nodes paint above them. */}
          {positions.map((p, i) => {
            const d = clients[i]
            const offline = !d.online
            return (
              <line
                key={`link-${d.mac}`}
                x1={CX}
                y1={CY}
                x2={p.x}
                y2={p.y}
                stroke={d.kicked != null ? '#EF4444' : offline ? '#141414' : '#2E2E2E'}
                strokeWidth={1}
                // Dashed link for a blocked device, matching its node ring.
                strokeDasharray={d.kicked != null ? '4 4' : undefined}
                opacity={offline ? 0.4 : 0.75}
              />
            )
          })}

          {/* Router hub. */}
          <g transform={`translate(${CX} ${CY})`}>
            <circle r={52} fill="rgba(255,255,255,0.03)" />
            <circle r={36} fill="var(--color-surface2)" stroke="#EDEDED" strokeWidth={1} />
            <foreignObject x={-13} y={-13} width={26} height={26}>
              <Router size={24} color="#8F8F8F" />
            </foreignObject>
            <text
              y={72}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill="#FFFFFF"
            >
              {routerName}
            </text>
            <text
              y={86}
              textAnchor="middle"
              fontSize={10}
              fill="#525252"
              fontFamily="Geist Mono, monospace"
            >
              {gatewayMac}
            </text>
          </g>

          {positions.map((p, i) => (
            <Node key={clients[i].mac} d={clients[i]} x={p.x} y={p.y} />
          ))}
        </svg>
      </div>

      {/* Legend row of chips doubles as a compact, accessible list. */}
      <ul className="mt-4 flex flex-wrap gap-2">
        {clients.map((d) => (
          <li key={d.mac} className="max-w-full">
            <Link
              to={`/devices/${encodeURIComponent(d.mac)}`}
              className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 min-h-9 hover:border-border-strong transition"
            >
              <DeviceChip
                type={d.device_type}
                vendor={d.vendor}
                hostname={d.hostname}
                brandOverride={d.brand_override}
                size={22}
              />
              <span
                className={`text-[12px] truncate max-w-[150px] ${
                  d.online ? 'text-ink' : 'text-muted'
                }`}
              >
                {displayName(d)}
              </span>
              <span
                className={`badge ${
                  d.kicked != null
                    ? 'badge-kicked'
                    : d.online
                      ? 'badge-online'
                      : 'badge-offline'
                }`}
              >
                {d.kicked != null
                  ? t('topologyMap.kickedLabel')
                  : d.online
                    ? t('topologyMap.online')
                    : t('topologyMap.offline')}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}