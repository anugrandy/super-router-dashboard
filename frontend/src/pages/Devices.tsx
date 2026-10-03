import { useEffect, useState } from 'react'
import { api } from '../api'
import DeviceTable from '../components/DeviceTable'
import { ScanButton } from '../components/Layout'
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
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Devices</h1>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {connected ? 'live' : 'mode polling'}
          </span>
          <ScanButton />
        </div>
      </div>

      {err && (
        <div className="card px-4 py-3 border-rose-500/40 bg-rose-500/10 text-sm text-rose-200">
          {err}
        </div>
      )}

      <DeviceTable devices={devices} />
    </div>
  )
}