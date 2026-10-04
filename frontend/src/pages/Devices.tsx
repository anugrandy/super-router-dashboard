import { useEffect, useState } from 'react'
import { api } from '../api'
import DeviceTable from '../components/DeviceTable'
import { PageHeader, ScanButton } from '../components/Layout'
import { useLive } from '../live'

export default function Devices() {
  const { devices, connected } = useLive()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    // A failed WS connection leaves the table empty; fall back to a REST pull
    // so the page still works if websockets are blocked.
    if (!connected) {
      api
        .devices()
        .then(() => setErr(null))
        .catch((e) => setErr(e instanceof Error ? e.message : 'Gagal memuat device'))
    }
  }, [connected])

  return (
    <div>
      <PageHeader
        title="Devices"
        subtitle={
          <>
            {devices.length} perangkat terdaftar
            <span className="mx-2 text-[#58585F]">|</span>
            {connected ? 'live' : 'mode polling'}
          </>
        }
        actions={<ScanButton />}
      />

      {err && (
        <div className="card px-4 py-3 border-[rgba(232,96,74,0.32)] bg-[rgba(232,96,74,0.07)] text-sm text-[#E8604A] mb-4">
          {err}
        </div>
      )}

      <DeviceTable devices={devices} />
    </div>
  )
}