import { useEffect, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import Viewer from './Viewer';
import { uploadSong, pollJob, type Motion } from './api';

export default function App() {
  const [motion, setMotion] = useState<Motion | null>(null);
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

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      setStatus('uploading...');
      const jobId = await uploadSong(file);
      setStatus('generating...');
      setMotion(await pollJob(jobId));
      setStatus(`playing ${file.name}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Viewer motion={motion} />
      <div style={bar}>
        <label style={button}>
          {busy ? 'working...' : 'Upload song'}
          <input type="file" accept="audio/*" onChange={onFile} disabled={busy}
            style={{ display: 'none' }} />
        </label>
        <span style={{ color: '#cfd2d6' }}>{status}</span>
      </div>
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
