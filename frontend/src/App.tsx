import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import Viewer, { type ViewerHandle } from './Viewer';
import Transport from './Transport';
import { uploadSong, pollJob, type Motion } from './api';
import { defaultParams } from './retarget';
import type { Params } from './core/retargetCore';

export default function App() {
  const [motion, setMotion] = useState<Motion | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [characterUrl, setCharacterUrl] = useState('/character.glb');
  const [characterFbx, setCharacterFbx] = useState(false);
  const [count, setCount] = useState(1);
  const [variation, setVariation] = useState(0);
  const [params, setParams] = useState<Params>(() => defaultParams());
  const audioRef = useRef<HTMLAudioElement>(null);
  const viewerRef = useRef<ViewerHandle>(null);

  // Live tuning: each change reruns the retarget on every dancer's core. With
  // the WASM core that stays interactive into the tens of dancers.
  const setParam = (k: 'rootUpright' | 'footLock' | 'recenterWin', v: number) =>
    setParams((p) => ({ ...p, [k]: v }));

  // Audio is the master clock. The dance plays once (it is only ~30s, and
  // looping a non-cyclic clip pops hard at the seam), so the frame tracks audio
  // time and clamps to the last frame. No default clip; rest until uploaded.
  const danceDur = motion ? motion.num_frames / motion.fps : 1;
  const frame = motion ? Math.min(currentTime * motion.fps, motion.num_frames - 1) : 0;

  // While playing, follow the audio element's time; stop at the dance's end.
  useEffect(() => {
    if (!playing || !motion) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        if (audio.currentTime >= danceDur) {
          audio.pause();
          setCurrentTime(danceDur);
          setPlaying(false);
          return;
        }
        setCurrentTime(audio.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, motion, danceDur]);

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

  function onCharacterFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCharacterFbx(file.name.toLowerCase().endsWith('.fbx'));
    setCharacterUrl((prev) => {
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  return (
    <>
      <Viewer ref={viewerRef} characterUrl={characterUrl} characterFbx={characterFbx}
        motion={motion} frame={frame} count={count} params={params} variation={variation} />
      <audio ref={audioRef} src={audioUrl ?? undefined} />
      <div style={bar}>
        <label style={button}>
          {busy ? 'working...' : 'Upload song'}
          <input type="file" accept="audio/*" onChange={onFile} disabled={busy}
            style={{ display: 'none' }} />
        </label>
        <label style={button}>
          Character
          <input type="file" accept=".glb,.gltf,.fbx" onChange={onCharacterFile}
            style={{ display: 'none' }} />
        </label>
        <button style={button} onClick={() => viewerRef.current?.exportGLB()} disabled={!motion}>
          Download .glb
        </button>
        <span style={{ color: '#cfd2d6' }}>{status}</span>
      </div>
      <div style={panel}>
        <div style={panelTitle}>motion core (WASM)</div>
        <Slider label="Dancers" value={count} min={1} max={400} step={1}
          onChange={setCount} />
        <Slider label="Variation" value={variation} min={0} max={1} step={0.05}
          onChange={setVariation} fmt={(v) => v.toFixed(2)} />
        <Slider label="Upright" value={params.rootUpright} min={0} max={1} step={0.05}
          onChange={(v) => setParam('rootUpright', v)} fmt={(v) => v.toFixed(2)} />
        <Slider label="Foot lock" value={params.footLock} min={0} max={1} step={0.05}
          onChange={(v) => setParam('footLock', v)} fmt={(v) => v.toFixed(2)} />
        <Slider label="Recenter" value={params.recenterWin} min={1} max={121} step={2}
          onChange={(v) => setParam('recenterWin', v)} />
      </div>
      {motion && (
        <Transport
          playing={playing}
          currentTime={currentTime}
          duration={danceDur}
          beats={motion.audio?.beats ?? []}
          downbeats={motion.audio?.downbeats ?? []}
          onTogglePlay={() => {
            const audio = audioRef.current;
            if (audio && audio.currentTime >= danceDur - 0.05) {
              audio.currentTime = 0;
              setCurrentTime(0);
            }
            setPlaying((p) => !p);
          }}
          onSeek={(s) => {
            const t = Math.min(Math.max(s, 0), danceDur);
            if (audioRef.current) audioRef.current.currentTime = t;
            setCurrentTime(t);
          }}
        />
      )}
    </>
  );
}

function Slider({ label, value, min, max, step, onChange, fmt }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; fmt?: (v: number) => string;
}) {
  return (
    <label style={row}>
      <span style={{ width: 64 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
      <span style={{ width: 34, textAlign: 'right' }}>{fmt ? fmt(value) : value}</span>
    </label>
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
const panel: CSSProperties = {
  position: 'fixed', top: 12, right: 12, width: 240, padding: 12,
  background: 'rgba(20,24,28,0.82)', borderRadius: 8, color: '#cfd2d6',
  fontFamily: 'system-ui, sans-serif', fontSize: 13,
  display: 'flex', flexDirection: 'column', gap: 8,
};
const panelTitle: CSSProperties = { color: '#aa3bff', fontWeight: 600 };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
