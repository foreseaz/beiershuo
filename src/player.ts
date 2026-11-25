import { useCallback, useEffect, useRef, useState } from 'react'
import { episodeLabel, type Episode, type Moment } from './domain'

/** What to play: an episode from startSec, stopping at endSec (one segment) or running on to the end (null). */
export type Cue = { episode: Episode; startSec: number; endSec: number | null; title: string; momentId?: string }

// The last moments of a segment fade out rather than cut off, where the browser lets a page set the volume (iOS does not).
const FADE = 1.2
const SKIP_BACK = 15
const SKIP_FORWARD = 30
const ARTWORK = '/brand/show-cover.png'

/**
 * Each episode's segments in order: `cue` bounds a start time by its segment's end (its own end, or else the next
 * chapter's start) and `next` finds the segment after a cue's end.
 */
export function segmentsOf(moments: readonly Moment[]) {
  const byEpisode = new Map<string, Moment[]>()
  for (const moment of moments) {
    const list = byEpisode.get(moment.episodeId)
    if (list) list.push(moment)
    else byEpisode.set(moment.episodeId, [moment])
  }
  for (const list of byEpisode.values()) list.sort((a, b) => a.startSec - b.startSec)

  const cue = (episode: Episode, startSec: number, title: string, whole = false): Cue => {
    if (whole) return { episode, startSec, endSec: null, title }
    const moment = byEpisode.get(episode.id)?.find(item => item.startSec === startSec)
    const endSec = moment?.endSec ?? episode.chapters.find(chapter => chapter.startSec > startSec)?.startSec ?? null
    return { episode, startSec, endSec, title, momentId: moment?.id }
  }
  const next = (current: Cue): Cue | null => {
    const { episode, startSec, endSec } = current
    if (endSec === null) return null
    const after = (start: number) => start > startSec && start >= endSec - 1 && start < episode.playableDurationSec
    const moment = byEpisode.get(episode.id)?.find(item => after(item.startSec))
    if (moment) return { episode, startSec: moment.startSec, endSec: moment.endSec, title: moment.title, momentId: moment.id }
    const chapter = episode.chapters.find(item => after(item.startSec))
    return chapter ? cue(episode, chapter.startSec, chapter.title) : null
  }
  return { cue, next }
}

/**
 * One shared <audio> element that plays the original episode audio from a timestamp. A segment fades out and pauses
 * at its end; seeking past the end lets the episode run on. The lock screen gets the show's cover, skip back and
 * forward, and a scrubber.
 */
export function usePlayer(nextOf: (cue: Cue) => Cue | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [cue, setCueState] = useState<Cue | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [finished, setFinishedState] = useState(false)
  const [position, setPosition] = useState(0)
  const [error, setError] = useState('')
  // The audio events read these, so they never wait for a render.
  const cueRef = useRef<Cue | null>(null)
  const finishedRef = useRef(false)
  const nextRef = useRef(nextOf)
  nextRef.current = nextOf
  const playRef = useRef<(cue: Cue) => void>(() => {})

  const setCue = (next: Cue | null) => {
    cueRef.current = next
    setCueState(next)
  }
  const setFinished = (value: boolean) => {
    finishedRef.current = value
    setFinishedState(value)
  }

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'none'
    audioRef.current = audio
    const session = 'mediaSession' in navigator ? navigator.mediaSession : null
    let fading = 0

    const syncSession = () => {
      if (!session) return
      session.playbackState = audio.paused ? 'paused' : 'playing'
      if (!Number.isFinite(audio.duration) || !session.setPositionState) return
      try {
        session.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate })
      } catch { /* an out-of-range moment while seeking */ }
    }
    const finish = () => {
      const end = cueRef.current?.endSec
      audio.pause()
      audio.volume = 1
      finishedRef.current = true
      setFinishedState(true)
      if (end != null) setPosition(end)
    }
    // Near the end of a segment, follow it every frame: fade the volume down and stop right at the end.
    const watchEnd = () => {
      fading = 0
      const end = cueRef.current?.endSec
      if (end == null || audio.paused) {
        audio.volume = 1
        return
      }
      const remaining = end - audio.currentTime
      if (remaining <= 0.04) return finish()
      audio.volume = Math.min(1, Math.max(0, remaining / FADE))
      fading = requestAnimationFrame(watchEnd)
    }
    const onTime = () => {
      setPosition(audio.currentTime)
      const end = cueRef.current?.endSec
      if (end != null && !fading && !audio.paused && end - audio.currentTime < FADE + 0.4) watchEnd()
    }
    const onSeeked = () => {
      const current = cueRef.current
      // Past the end of the segment: the person wants to keep listening, so the episode runs on.
      if (current && current.endSec !== null && audio.currentTime > current.endSec + 0.5) {
        cueRef.current = { ...current, endSec: null }
        setCueState(cueRef.current)
      }
      if (finishedRef.current && current && audio.currentTime < (current.endSec ?? Infinity) - 0.5) {
        finishedRef.current = false
        setFinishedState(false)
      }
      setPosition(audio.currentTime)
      syncSession()
    }
    const onPlay = () => {
      setPlaying(true)
      finishedRef.current = false
      setFinishedState(false)
      syncSession()
    }
    const onPlaying = () => setLoading(false)
    const onWaiting = () => setLoading(true)
    const onPause = () => {
      setPlaying(false)
      setLoading(false)
      syncSession()
    }
    const onEnded = () => {
      finishedRef.current = true
      setFinishedState(true)
    }
    const onError = () => {
      setPlaying(false)
      setLoading(false)
      setError('音频暂时无法播放')
    }
    const listeners: [string, () => void][] = [
      ['timeupdate', onTime], ['seeked', onSeeked], ['play', onPlay], ['playing', onPlaying], ['waiting', onWaiting],
      ['pause', onPause], ['ended', onEnded], ['error', onError], ['loadedmetadata', syncSession], ['ratechange', syncSession],
    ]
    for (const [name, listener] of listeners) audio.addEventListener(name, listener)

    const seekTo = (time: number) => {
      if (!cueRef.current) return
      audio.currentTime = Math.max(0, Math.min(time, Number.isFinite(audio.duration) ? audio.duration : time))
    }
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => { if (cueRef.current) void audio.play().catch(() => {}) }],
      ['pause', () => audio.pause()],
      ['seekbackward', details => seekTo(audio.currentTime - (details.seekOffset ?? SKIP_BACK))],
      ['seekforward', details => seekTo(audio.currentTime + (details.seekOffset ?? SKIP_FORWARD))],
      ['seekto', details => { if (details.seekTime != null) seekTo(details.seekTime) }],
      ['previoustrack', () => { const current = cueRef.current; if (current) playRef.current(current) }],
      ['nexttrack', () => { const current = cueRef.current; const next = current && nextRef.current(current); if (next) playRef.current(next) }],
    ]
    for (const [action, handler] of actions) {
      try { session?.setActionHandler(action, handler) } catch { /* this browser lacks the action */ }
    }

    return () => {
      cancelAnimationFrame(fading)
      audio.pause()
      audio.removeAttribute('src')
      for (const [name, listener] of listeners) audio.removeEventListener(name, listener)
      for (const [action] of actions) {
        try { session?.setActionHandler(action, null) } catch { /* as above */ }
      }
    }
  }, [])

  const play = useCallback((next: Cue) => {
    const audio = audioRef.current
    const { episode, startSec } = next
    // Beyond the publicly playable range (e.g. a trial clip) the original platform takes over.
    if (!audio || !episode.audioUrl || startSec >= episode.playableDurationSec) {
      window.open(episode.xiaoyuzhouUrl, '_blank', 'noopener')
      return
    }
    setError('')
    setFinished(false)
    setLoading(true)
    setCue(next)
    setPosition(startSec)
    audio.volume = 1
    if (audio.src !== episode.audioUrl) audio.src = episode.audioUrl
    const fail = () => {
      setLoading(false)
      setError('点一下播放按钮开始')
    }
    if (audio.readyState >= 1) {
      audio.currentTime = startSec
    } else {
      // Seek once the length is known, before any sound; play() is still called now, inside the tap, so iOS allows it.
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = cueRef.current?.startSec ?? startSec }, { once: true })
    }
    void audio.play().catch(fail)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: next.title, artist: `${episodeLabel(episode)} · 次要人生`, album: '贝儿说',
        artwork: [{ src: new URL(ARTWORK, window.location.origin).href, sizes: '300x300', type: 'image/png' }],
      })
    }
  }, [])
  playRef.current = play

  const toggle = useCallback(() => {
    const audio = audioRef.current
    const current = cueRef.current
    if (!audio || !current) return
    if (!audio.paused) {
      audio.pause()
      return
    }
    // A finished segment plays again from its start.
    if (finishedRef.current) audio.currentTime = current.startSec
    setError('')
    void audio.play().catch(() => setError('音频暂时无法播放'))
  }, [])

  const back = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !cueRef.current) return
    audio.currentTime = Math.max(0, audio.currentTime - SKIP_BACK)
  }, [])

  const close = useCallback(() => {
    audioRef.current?.pause()
    setCue(null)
    setFinished(false)
    setLoading(false)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
    }
  }, [])

  const next = cue ? nextOf(cue) : null
  return { cue, playing, loading, finished, position, error, next, play, toggle, back, close }
}
