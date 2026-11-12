import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Device } from '../api'
import DeviceTable from '../components/DeviceTable'
import { PageHeader, ScanButton } from '../components/Layout'
import { useLive } from '../live'

export default function Devices() {
  const { t } = useTranslation()
  const {
    devices: liveDevices,
    connected,
    isViewingActive,
    viewProfileId,
    lastEventAt,
  } = useLive()
  const [restDevices, setRestDevices] = useState<Device[]>([])
  const [err, setErr] = useState<string | null>(null)

  // The socket only carries the *active* network. A historical view (or a
  // blocked websocket) is served by the scoped REST endpoint instead.
  const useRest = !isViewingActive || !connected
  useEffect(() => {
    if (!useRest) return
    api
      .devices(isViewingActive ? null : viewProfileId)
      .then((res) => {
        setRestDevices(res.devices)
        setErr(null)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : t('devices.loadError')))
  }, [useRest, isViewingActive, viewProfileId, lastEventAt, t])

  const devices = useRest ? restDevices : liveDevices

  return (
    <div>
      <PageHeader
        title={t('devices.title')}
        subtitle={
          <>
            {t('devices.subtitle', { n: devices.length })}
            <span className="mx-2 text-muted2">|</span>
            {!isViewingActive
              ? t('profiles.historyLabel')
              : connected
                ? t('devices.live')
                : t('devices.polling')}
          </>
        }
      />

      {err && <div className="notice notice-danger mb-5">{err}</div>}

      <DeviceTable devices={devices} actions={<ScanButton />} />
    </div>
  )
}
