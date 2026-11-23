import { useCallback, useEffect, useRef, useState } from 'react'
import { episodeLabel, timeLabel, type Episode } from './domain'

export type Cue = { episode: Episode; startSec: number; title: string }

/** One shared <audio> element that plays the original episode audio from a timestamp. */
export function usePlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [cue, setCue] = useState<Cue | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'none'
    audioRef.current = audio
    const update = () => setPosition(audio.currentTime)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onError = () => { setPlaying(false); setError('音频暂时无法播放') }
    audio.addEventListener('timeupdate', update)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('error', onError)
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.removeEventListener('timeupdate', update)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('error', onError)
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
    setCue(next)
    if (audio.src !== episode.audioUrl) audio.src = episode.audioUrl
    const start = () => {
      audio.currentTime = startSec
      void audio.play().catch(() => setError('点一下播放按钮开始'))
    }
    if (audio.readyState >= 1) start()
    else {
      audio.addEventListener('loadedmetadata', start, { once: true })
      audio.load()
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: next.title, artist: `${episodeLabel(episode)} · ${timeLabel(startSec)}`, album: '次要人生 · 贝儿说',
      })
    }
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !cue) return
    if (audio.paused) void audio.play().catch(() => setError('音频暂时无法播放'))
    else audio.pause()
  }, [cue])

  const close = useCallback(() => {
    audioRef.current?.pause()
    setCue(null)
  }, [])

  return { cue, playing, position, error, play, toggle, close }
}
