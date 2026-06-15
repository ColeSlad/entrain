import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import Viewer from './Viewer';
import Transport from './Transport';
import { uploadSong, pollJob, type Motion } from './api';

export default function App() {
  const [motion, setMotion] = useState<Motion | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Audio is the master clock. The dance is shorter than most songs, so it
  // loops within the audio: frame = (audioTime mod danceDuration) * fps. No
  // default clip; the character rests until a song is uploaded.
  const danceDur = motion ? motion.num_frames / motion.fps : 1;
  const frame = motion ? (currentTime % danceDur) * motion.fps : 0;

  // While playing, follow the audio element's time each animation frame.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentTime(audio.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Reflect play/pause onto the audio element. If the browser blocks autoplay
  // (no recent user gesture), fall back to paused so the Play button starts it.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (playing) audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, [playing, audioUrl]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      setStatus('uploading...');
      const jobId = await uploadSong(file);
      setStatus('generating...');
      const result = await pollJob(jobId);
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      setMotion(result);
      setCurrentTime(0);
      setPlaying(true);
      setStatus(`playing ${file.name}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Viewer motion={motion} frame={frame} />
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        loop
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
      <div style={bar}>
        <label style={button}>
          {busy ? 'working...' : 'Upload song'}
          <input type="file" accept="audio/*" onChange={onFile} disabled={busy}
            style={{ display: 'none' }} />
        </label>
        <span style={{ color: '#cfd2d6' }}>{status}</span>
      </div>
      {motion && (
        <Transport
          playing={playing}
          currentTime={currentTime}
          duration={duration}
          onTogglePlay={() => setPlaying((p) => !p)}
          onSeek={(s) => {
            if (audioRef.current) audioRef.current.currentTime = s;
            setCurrentTime(s);
          }}
        />
      )}
    </>
  );
}

const bar: CSSProperties = {
  position: 'fixed', top: 12, left: 12, display: 'flex', gap: 12,
  alignItems: 'center', fontFamily: 'system-ui, sans-serif', fontSize: 14,
};
const button: CSSProperties = {
  background: '#aa3bff', color: 'white', padding: '8px 14px',
  borderRadius: 6, cursor: 'pointer', userSelect: 'none',
};
