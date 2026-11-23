import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Site background music. If a licensed recording is deployed at /audio/bgm.mp3 it plays on a
 * loop; otherwise an original generative piece is made in the browser (a soft pad and sparse
 * piano-like notes in D major pentatonic through a long reverb). Both duck the same way.
 */

export type Duck = 'none' | 'low' | 'mute'

const LEVELS: Record<Duck, number> = { none: 0.5, low: 0.1, mute: 0 }
const SCALE = [62, 64, 66, 69, 71, 74, 76, 78, 81] // MIDI: D4 E4 F#4 A4 B4 D5 E5 F#5 A5
const PREFERENCE = 'beiershuo:music'
const TRACK_URL = '/audio/bgm.mp3'

type Engine = { start(): void; level(value: number, seconds?: number): void; suspend(): void; resume(): void; dispose(): void }

const frequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)

function impulse(context: AudioContext, seconds: number, decay: number) {
  const length = Math.floor(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay)
  }
  return buffer
}

class AmbientEngine implements Engine {
  private readonly context = new AudioContext()
  private readonly master = this.context.createGain()
  private readonly bus = this.context.createGain()
  private readonly voices: AudioScheduledSourceNode[] = []
  private timer = 0

  constructor() {
    const { context } = this
    this.master.gain.value = 0
    const reverb = context.createConvolver()
    reverb.buffer = impulse(context, 5, 2.4)
    const wet = context.createGain()
    wet.gain.value = 0.6
    const dry = context.createGain()
    dry.gain.value = 0.4
    const compressor = context.createDynamicsCompressor()
    this.bus.connect(dry).connect(this.master)
    this.bus.connect(reverb).connect(wet).connect(this.master)
    this.master.connect(compressor).connect(context.destination)
    this.pad()
  }

  /** A low, slowly breathing chord under everything. */
  private pad() {
    const { context } = this
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 700
    const swell = context.createOscillator()
    swell.frequency.value = 0.05
    const depth = context.createGain()
    depth.gain.value = 260
    swell.connect(depth).connect(filter.frequency)
    const level = context.createGain()
    level.gain.value = 0.045
    filter.connect(level).connect(this.bus)
    for (const [midi, detune] of [[50, -6], [57, 4], [66, -3], [69, 7]]) {
      const tone = context.createOscillator()
      tone.type = 'triangle'
      tone.frequency.value = frequency(midi)
      tone.detune.value = detune
      tone.connect(filter)
      tone.start()
      this.voices.push(tone)
    }
    swell.start()
    this.voices.push(swell)
  }

  /** One soft, bell-like note with a long tail. */
  private note(midi: number, at: number, velocity: number) {
    const { context } = this
    const envelope = context.createGain()
    envelope.gain.setValueAtTime(0, at)
    envelope.gain.linearRampToValueAtTime(0.09 * velocity, at + 0.015)
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 4.5)
    envelope.connect(this.bus)
    for (const [ratio, type, gain] of [[1, 'sine', 1], [2, 'triangle', 0.18]] as const) {
      const tone = context.createOscillator()
      tone.type = type
      tone.frequency.value = frequency(midi) * ratio
      const partial = context.createGain()
      partial.gain.value = gain
      tone.connect(partial).connect(envelope)
      tone.start(at)
      tone.stop(at + 4.6)
    }
  }

  private phrase = () => {
    const at = this.context.currentTime + 0.05
    const root = SCALE[Math.floor(Math.random() * SCALE.length)]
    this.note(root, at, 0.7 + Math.random() * 0.3)
    if (Math.random() < 0.45) {
      const answer = SCALE[Math.max(0, Math.min(SCALE.length - 1, SCALE.indexOf(root) + (Math.random() < 0.5 ? -2 : 2)))]
      this.note(answer, at + 0.6 + Math.random() * 0.9, 0.5)
    }
    this.timer = window.setTimeout(this.phrase, 2600 + Math.random() * 4200)
  }

  start() {
    void this.context.resume()
    if (!this.timer) this.timer = window.setTimeout(this.phrase, 800)
  }

  level(value: number, seconds = 1.2) {
    const now = this.context.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setTargetAtTime(value, now, seconds / 3)
  }

  suspend() { void this.context.suspend() }
  resume() { void this.context.resume() }

  dispose() {
    window.clearTimeout(this.timer)
    for (const voice of this.voices) voice.stop()
    void this.context.close()
  }
}

/** A licensed recording, looped, routed through a gain node so ducking ramps smoothly. */
class TrackEngine implements Engine {
  private readonly context = new AudioContext()
  private readonly master = this.context.createGain()
  private readonly audio = new Audio(TRACK_URL)

  constructor() {
    this.audio.loop = true
    this.audio.preload = 'auto'
    this.master.gain.value = 0
    this.context.createMediaElementSource(this.audio).connect(this.master).connect(this.context.destination)
  }

  start() {
    void this.context.resume()
    void this.audio.play().catch(() => undefined)
  }

  // Recordings are mixed much louder than the generated piece.
  level(value: number, seconds = 1.2) {
    const now = this.context.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setTargetAtTime(value * 0.55, now, seconds / 3)
  }

  suspend() { void this.context.suspend() }
  resume() { void this.context.resume() }

  dispose() {
    this.audio.pause()
    this.audio.removeAttribute('src')
    void this.context.close()
  }
}

/** True when a real audio file is deployed (a missing file falls back to the HTML page). */
async function hasTrack() {
  try {
    // A one-byte GET: some static servers answer HEAD with the app's HTML even when the file exists.
    const response = await fetch(TRACK_URL, { headers: { Range: 'bytes=0-0' } })
    void response.body?.cancel()
    return response.ok && (response.headers.get('content-type') ?? '').startsWith('audio/')
  } catch {
    return false
  }
}

function readPreference() {
  try { return window.localStorage.getItem(PREFERENCE) !== 'off' } catch { return true }
}

function writePreference(on: boolean) {
  try { window.localStorage.setItem(PREFERENCE, on ? 'on' : 'off') } catch { /* private mode: keep it per page */ }
}

/** Shown next to the music button while the file at /audio/bgm.mp3 is playing. */
export const TRACK_CREDIT = '《Iki》Hideyuki Hashimoto'

type Source = 'pending' | 'file' | 'generative'

/**
 * Plays the site music after the first interaction (browsers block autoplay) and ducks it under
 * episodes. A file deployed at /audio/bgm.mp3 is used when present; otherwise the generated piece.
 */
export function useAmbient(duck: Duck) {
  const [enabled, setEnabled] = useState(readPreference)
  const [source, setSource] = useState<Source>('pending')
  const [running, setRunning] = useState(false)
  const engine = useRef<Engine | null>(null)
  const wants = useRef(false)
  const state = useRef({ enabled, duck })
  state.current = { enabled, duck }

  // Decide the source before the first click, so the engine can be built inside the gesture.
  useEffect(() => {
    let live = true
    void hasTrack().then(found => { if (live) setSource(found ? 'file' : 'generative') })
    return () => { live = false }
  }, [])

  const startIfReady = useCallback(() => {
    if (!wants.current || !state.current.enabled || source === 'pending') return
    if (!engine.current) {
      try { engine.current = source === 'file' ? new TrackEngine() : new AmbientEngine() } catch { return }
    }
    engine.current.start()
    engine.current.level(LEVELS[state.current.duck], 3)
    setRunning(true)
  }, [source])

  useEffect(() => { startIfReady() }, [startIfReady])

  useEffect(() => {
    const begin = () => {
      wants.current = true
      startIfReady()
    }
    window.addEventListener('pointerdown', begin, { once: true })
    window.addEventListener('keydown', begin, { once: true })
    return () => {
      window.removeEventListener('pointerdown', begin)
      window.removeEventListener('keydown', begin)
    }
  }, [startIfReady])

  useEffect(() => {
    if (running) engine.current?.level(enabled ? LEVELS[duck] : 0, duck === 'none' ? 2.5 : 0.8)
  }, [duck, enabled, running])

  useEffect(() => {
    const onVisibility = () => (document.hidden ? engine.current?.suspend() : engine.current?.resume())
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      engine.current?.dispose()
      engine.current = null
    }
  }, [])

  const toggle = useCallback(() => {
    const next = !state.current.enabled
    wants.current = true
    setEnabled(next)
    writePreference(next)
    if (next) startIfReady()
  }, [startIfReady])

  return { enabled, toggle, playing: running && enabled, credit: source === 'file' ? TRACK_CREDIT : null }
}
