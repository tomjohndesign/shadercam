"use client"

import { useEffect, useRef, useState } from "react"

type CameraStatus = { state: string; message: string; connected: boolean; framesSent: number; transportError?: string }
type CameraAPI = {
  status: () => Promise<CameraStatus>
  activate: () => Promise<CameraStatus>
  sendFrame: (pixels: Uint8Array) => Promise<boolean>
  stop: () => Promise<void>
  openSettings: () => Promise<void>
}
declare global { interface Window { stippleCamera?: CameraAPI } }

export function useNativeCamera(active: boolean) {
  const [status, setStatus] = useState<CameraStatus | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
  const publish = useRef<(canvas: HTMLCanvasElement) => void>(() => {})

  useEffect(() => {
    const api = window.stippleCamera
    if (!api) return
    let cancelled = false
    let polling = false
    const refresh = async () => {
      if (polling) return
      polling = true
      try { const next = await api.status(); if (!cancelled) setStatus(next) }
      catch { if (!cancelled) setFrameError("Could not communicate with the camera component. Reopen Stipple Cam.") }
      finally { polling = false }
    }
    void refresh()
    const timer = setInterval(refresh, 1000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  useEffect(() => {
    const api = window.stippleCamera
    if (!api) return
    if (!active || status?.state !== "ready") {
      publish.current = () => {}
      void api.stop().catch(() => {})
      return
    }
    const capture = document.createElement("canvas")
    capture.width = 1280; capture.height = 720
    const context = capture.getContext("2d", { willReadFrequently: true })
    if (!context) { setFrameError("Could not prepare camera frames."); return }
    let busy = false
    let cancelled = false
    let last = 0
    setFrameError(null)
    publish.current = canvas => {
      const now = performance.now()
      if (busy || now - last < 1000 / 30) return
      last = now
      busy = true
      try {
        // Called immediately after WebGL render, before its drawing buffer is cleared.
        context.drawImage(canvas, 0, 0, 1280, 720)
        const pixels = context.getImageData(0, 0, 1280, 720).data
        void api.sendFrame(new Uint8Array(pixels.buffer)).catch(() => {
          if (!cancelled) setFrameError("Video output was interrupted. Stop and restart the camera.")
        }).finally(() => { busy = false })
      } catch {
        busy = false
        if (!cancelled) setFrameError("Could not read the video frame. Stop and restart the camera.")
      }
    }
    return () => {
      cancelled = true
      publish.current = () => {}
      void api.stop().catch(() => {})
    }
  }, [active, status?.state])

  return { status, frameError, publish }
}

export function NativeCameraStatus({ status, frameError, active }: { status: CameraStatus | null; frameError: string | null; active: boolean }) {
  const [actionError, setActionError] = useState<string | null>(null)
  async function retry() {
    setActionError(null)
    try { await window.stippleCamera?.activate() } catch { setActionError("Could not enable the camera. Reopen Stipple Cam to retry.") }
  }
  return <div className="space-y-2 rounded-lg bg-white/5 p-3 text-[12px] leading-relaxed text-white/65" aria-live="polite">
    <div className="font-medium text-white/90">Stipple Cam for meetings</div>
    {!status ? <p>The Mac app adds Stipple Cam directly to your meeting app’s camera menu. This browser is a preview of the effect.</p> : <>
      <p>{status.state === "ready" ? active ? status.connected ? "Camera output is running. Select Stipple Cam in your call." : status.transportError || "Connecting video output…" : "Camera stopped. Calls receive a black image." : status.message}</p>
      <p>Keep Stipple Cam open during your call. Use your usual microphone in the meeting app.</p>
      {status.state === "approval" && <button type="button" className="w-full rounded bg-white/10 px-3 py-2 text-white hover:bg-white/15"
        onClick={() => { void window.stippleCamera?.openSettings().catch(() => setActionError("Open System Settings → General → Login Items & Extensions → Camera Extensions.")) }}>Open System Settings</button>}
      {status.state === "error" && <button type="button" className="w-full rounded bg-white/10 px-3 py-2 text-white hover:bg-white/15" onClick={retry}>Retry camera installation</button>}
    </>}
    {(frameError || actionError) && <p role="alert" className="text-amber-200">{frameError || actionError}</p>}
  </div>
}
