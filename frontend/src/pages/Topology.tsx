import { useLive } from '../live'
import { PageHeader } from '../components/Layout'
import TopologyMap from '../components/TopologyMap'
import { api, currentLocale, type Device } from '../api'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RouterHealth } from '../api'
import KpiStrip from '../components/Kpi'

/**
 * Topology page: the graph plus router health.
 *
 * Router health is fetched once on mount and then not polled. The backend caches
 * it for three minutes, so even a navigation back and forth barely touches the
 * router, and nothing re-renders on a timer.
 */
export default function TopologyPage() {
  const { t, i18n } = useTranslation()
  const {
    devices: liveDevices,
    isViewingActive,
    viewProfileId,
    lastEventAt,
  } = useLive()
  const [health, setHealth] = useState<RouterHealth | null>(null)
  const [historicDevices, setHistoricDevices] = useState<Device[]>([])

  // Historical profiles are served by REST because the socket only carries the
  // network the laptop is actually on.
  useEffect(() => {
    if (isViewingActive) return
    api
      .devices(viewProfileId)
      .then((r) => setHistoricDevices(r.devices))
      .catch(() => setHistoricDevices([]))
  }, [isViewingActive, viewProfileId, lastEventAt])

  const devices = isViewingActive ? liveDevices : historicDevices

  const loadHealth = useCallback(async () => {
    if (!isViewingActive) return
    try {
      setHealth(await api.routerHealth())
    } catch {
      setHealth(null)
    }
  }, [isViewingActive])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  // Per-core CPU values. The average is the headline figure; the router reports
  // one value per core, and summing them ("300%") would be meaningless.
  const cores = health?.available ? health.cpu_cores ?? [] : []
  const cpuAvg =
    cores.length > 0
      ? cores.reduce((a, b) => a + b, 0) / cores.length
      : null

  // When the router booted, derived from its own uptime counter. Held in state so
  // it is computed once per fetch rather than on every render.
  const bootedAt = useMemo(() => {
    if (!health?.available || !health.uptime_seconds) return ''
    const booted = new Date(Date.now() - health.uptime_seconds * 1000)
    return booted.toLocaleString(currentLocale(), {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  }, [health, i18n.language])

  const gateway = devices.find((d) => d.is_gateway)
  // Fall back to the .1 address when nothing has been flagged as the gateway.
  const gatewayMac = gateway?.mac ?? ''

  return (
    <div>
      <PageHeader
        title={t('topology.title')}
        subtitle={t('topology.subtitle', { n: devices.length })}
      />

      {isViewingActive && (
        <>
          <KpiStrip
            className="mb-4"
            mobileCols={1}
            items={[
              {
                label: t('topology.routerUptime'),
                value: health?.available ? health.uptime_human : '—',
                sub: bootedAt ? t('topology.bootedAt', { time: bootedAt }) : undefined,
              },
              {
                label: t('topology.cpuAverage'),
                value:
                  cpuAvg != null
                    ? `${cpuAvg.toFixed(cpuAvg < 10 ? 1 : 0)}%`
                    : '—',
                sub: cores.length
                  ? t('topology.coreDetail', {
                      values: cores.map((c) => `${c}%`).join(' / '),
                    })
                  : undefined,
              },
              {
                label: t('topology.memory'),
                value:
                  health?.available && health.mem_pct != null
                    ? `${health.mem_pct}%`
                    : '—',
                sub:
                  health?.available && health.mem_pct != null
                    ? t('topology.memoryUsed', { pct: health.mem_pct })
                    : undefined,
              },
            ]}
          />

          {health && !health.available && health.error && (
            <div className="notice notice-danger mb-4">
              {t('topology.healthError', { error: health.error })}
            </div>
          )}

          {health?.available && (
            <p className="mono mb-5 text-[11px] leading-relaxed text-muted2">
              {t('topology.firmwareLine', {
                model: health.model,
                firmware: health.software_version,
                serial: health.serial_number,
                n: health.cpu_cores?.length ?? 0,
              })}
            </p>
          )}
        </>
      )}

      <TopologyMap
        devices={devices}
        routerName={gateway ? t('topology.router') : t('topology.gateway')}
        gatewayMac={gatewayMac}
      />
    </div>
  )
}
