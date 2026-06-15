import { useEffect, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import Viewer from './Viewer';
import Transport from './Transport';
import { uploadSong, pollJob, type Motion } from './api';

export default function App() {
  const [motion, setMotion] = useState<Motion | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Play the committed fixture by default, so the stage is not empty and the
  // viewer works even before the backend is running.
  useEffect(() => {
    fetch('/sample_motion.json')
      .then((r) => r.json())
      .then((m: Motion) => setMotion((cur) => cur ?? m))
      .catch(() => {});
  }, []);

  // The playback clock: advance the frame while playing. App owns this so the
  // transport (play/pause/scrub) and the viewer share one source of truth.
  useEffect(() => {
    if (!playing || !motion) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setFrame((f) => (f + dt * motion.fps) % motion.num_frames);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, motion]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      setStatus('uploading...');
      const jobId = await uploadSong(file);
      setStatus('generating...');
      const result = await pollJob(jobId);
      setMotion(result);
      setFrame(0);
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
          frame={frame}
          numFrames={motion.num_frames}
          fps={motion.fps}
          onTogglePlay={() => setPlaying((p) => !p)}
          onSeek={(f) => { setPlaying(false); setFrame(f); }}
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
