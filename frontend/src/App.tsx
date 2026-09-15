import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import Viewer, { type ViewerHandle } from './Viewer';
import Transport from './Transport';
import { cancelJob, uploadSong, pollJob, type Motion, type GeneratorConnection, type GeneratorInfo } from './api';
import GeneratorSettings from './GeneratorSettings';
import { readGeneratorConnection } from './generatorPreferences';
import DanceSettings from './DanceSettings';
import Icon from './Icon';
import { defaultParams } from './retarget';
import type { Params } from './core/retargetCore';

const NO_BEATS: number[] = [];

export default function App() {
  const [motion, setMotion] = useState<Motion | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [songName, setSongName] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<GeneratorConnection | null>(() =>
    readGeneratorConnection(import.meta.env.DEV) ??
      (import.meta.env.DEV ? { url: 'http://localhost:8000', token: '' } : null),
  );
  const [generatorInfo, setGeneratorInfo] = useState<GeneratorInfo | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [job, setJob] = useState<{ connection: GeneratorConnection; id: string; abort: AbortController } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [characterUrl, setCharacterUrl] = useState('/character.glb');
  const [characterName, setCharacterName] = useState('Default character');
  const [characterFbx, setCharacterFbx] = useState(false);
  const [count, setCount] = useState(1);
  const [variation, setVariation] = useState(0);
  const [params, setParams] = useState<Params>(() => defaultParams());
  const audioRef = useRef<HTMLAudioElement>(null);
  const viewerRef = useRef<ViewerHandle>(null);
  const songInputRef = useRef<HTMLInputElement>(null);
  const characterInputRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  // Live tuning still goes to the motion worker; React only updates controls.
  const setParam = useCallback((key: 'rootUpright' | 'footLock' | 'recenterWin', value: number) =>
    setParams((previous) => ({ ...previous, [key]: value })), []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);

  // Audio is the master clock. Non-cyclic clips play once and clamp at the end.
  const danceDur = motion ? motion.num_frames / motion.fps : 0;
  const frame = motion ? Math.min(currentTime * motion.fps, motion.num_frames - 1) : 0;
  const uploadDisabled = busy || !!job || cancelling || !connection;

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

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (playing) audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, [playing, audioUrl]);

  const togglePlay = useCallback(() => {
    if (!motion) return;
    const audio = audioRef.current;
    if (audio && (audio.ended || audio.currentTime >= danceDur - 0.05)) {
      audio.currentTime = 0;
      setCurrentTime(0);
    }
    setPlaying((previous) => !previous);
  }, [motion, danceDur]);

  const seek = useCallback((seconds: number) => {
    const time = Math.min(Math.max(seconds, 0), danceDur);
    if (audioRef.current) audioRef.current.currentTime = time;
    setCurrentTime(time);
  }, [danceDur]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        generatorOpen || !(target instanceof HTMLElement) ||
        target.closest('input, textarea, select, button, summary, a, [contenteditable="true"]')) return;
      if (motion) { event.preventDefault(); togglePlay(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [motion, generatorOpen, togglePlay]);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !connection || busy || job || cancelling) return;
    if (generatorInfo && file.size > generatorInfo.max_upload_bytes) {
      setStatusError(true);
      setStatus('Audio exceeds this generator’s upload limit. Choose a smaller file.');
      return;
    }
    setBusy(true);
    setStatusError(false);
    const abort = new AbortController();
    try {
      setStatus(`Uploading ${file.name}…`);
      const jobId = await uploadSong(connection, file);
      setJob({ connection, id: jobId, abort });
      setStatus('Creating your dance. You can explore the stage while you wait.');
      const result = await pollJob(connection, jobId, 1000, 2_100_000, abort.signal);
      if (abort.signal.aborted) return;
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(file);
      });
      setSongName(file.name);
      setMotion(result);
      setCurrentTime(0);
      setPlaying(true);
      setStatus('');
      setJob(null);
    } catch (error) {
      setStatusError(!abort.signal.aborted);
      setStatus(abort.signal.aborted ? 'Generation cancelled.' : error instanceof Error ? error.message : 'Generation failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      await cancelJob(job.connection, job.id);
      job.abort.abort();
      setJob(null);
      setStatusError(false);
      setStatus('Generation cancelled.');
    } catch {
      setStatusError(true);
      setStatus('Could not confirm cancellation. Check your Modal dashboard; the job may still be running.');
    } finally {
      setCancelling(false);
    }
  }

  useEffect(() => {
    if (!busy && !job) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy, job]);

  function onCharacterFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setCharacterName(file.name);
    setCharacterFbx(file.name.toLowerCase().endsWith('.fbx'));
    setCharacterUrl((previous) => {
      if (previous.startsWith('blob:')) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
  }

  async function onExport() {
    if (!viewerRef.current || exporting) return;
    setExporting(true);
    try {
      await viewerRef.current.exportGLB();
    } catch (error) {
      setStatusError(true);
      setStatus(error instanceof Error ? error.message : 'Could not export the dance. Try again.');
    } finally {
      setExporting(false);
    }
  }

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand" aria-label="Entrain — music into motion">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="brand-name">entrain</span>
        <span className="brand-tagline">Music into motion</span>
      </div>
      <div className="header-actions">
        <button className={`button generator-button ${connection ? 'button-quiet' : 'button-primary'}`}
          onClick={() => setGeneratorOpen(true)} aria-haspopup="dialog" disabled={busy || !!job || cancelling}>
          {connection ? <span className="connection-dot" /> : <Icon name="connection" />}
          {connection ? 'Generator connected' : 'Connect generator'}
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button className="button button-secondary export-button" onClick={() => void onExport()} disabled={!motion || exporting}
          title={motion ? 'Download the character and animation as a GLB' : 'Generate a dance to export it'}>
          {exporting ? <span className="spinner" /> : <Icon name="download" />}<span>{exporting ? 'Exporting…' : 'Export GLB'}</span>
        </button>
        <button className={`button ${connection ? 'button-primary' : 'button-secondary'} upload-button`}
          disabled={uploadDisabled} onClick={() => songInputRef.current?.click()} title={!connection ? 'Connect a generator first' : undefined}>
          {busy ? <span className="spinner" /> : <Icon name="upload" />}<span>{busy ? 'Creating…' : 'Upload song'}</span>
        </button>
      </div>
    </header>

    <main className="workspace">
      <section className="stage" aria-label="Dance studio">
        <div className="stage-toolbar">
          <div className="stage-heading"><h1>Dance preview</h1><span className="dancer-count">{count} {count === 1 ? 'dancer' : 'dancers'}</span></div>
          <div className="stage-actions">
            <button className="button stage-button" onClick={() => characterInputRef.current?.click()} disabled={exporting} title={`Change character · ${characterName}`}><Icon name="person" /><span>Character</span></button>
            <button ref={settingsButtonRef} className={`button stage-button ${settingsOpen ? 'is-active' : ''}`} aria-expanded={settingsOpen}
              aria-controls="dance-settings" onClick={() => setSettingsOpen((previous) => !previous)}><Icon name="tune" /><span>Adjust dance</span></button>
          </div>
        </div>
        <Viewer ref={viewerRef} characterUrl={characterUrl} characterFbx={characterFbx}
          motion={motion} frame={frame} count={count} params={params} variation={variation} />
        {status && <div className="stage-notices">
          <div className={`notice ${statusError ? 'notice-error' : ''}`}>
            <div className="notice-content" role="status" aria-atomic="true">{busy && !statusError ? <span className="spinner" /> : <Icon name={statusError ? 'alert' : 'check'} />}<span>{status}</span></div>
            <div className="notice-actions">
              {job && <button className="button button-secondary" onClick={() => void onCancel()} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel generation'}</button>}
              {job && !busy && <button className="button button-quiet" disabled={cancelling} onClick={() => {
                if (window.confirm('Forget this job? This does not stop GPU billing. Cancel it in Modal first.')) setJob(null);
              }}>Forget job</button>}
              {!busy && !job && <button className="icon-button" aria-label="Dismiss message" onClick={() => setStatus('')}><Icon name="close" /></button>}
            </div>
          </div>
        </div>}
        {!motion && !busy && <div className="stage-welcome">
          <h2>A stage for your music.</h2>
          <p>{connection ? 'Upload a song and watch it become a dance.' : 'Connect your generator, then upload a song to get moving.'}</p>
        </div>}
        <div className="stage-footer">
          <span className="camera-hint">Drag to orbit <span>·</span> Scroll to zoom</span>
          <button className="button stage-button reset-view" onClick={() => viewerRef.current?.resetCamera()}><Icon name="restart" /><span>Reset view</span></button>
        </div>
      </section>
      {settingsOpen && <DanceSettings count={count} variation={variation} params={params} onCount={setCount}
        onVariation={setVariation} onParam={setParam} onClose={closeSettings} />}
    </main>

    <Transport playing={playing} currentTime={currentTime} duration={danceDur} songName={songName} enabled={!!motion}
      beats={motion?.audio?.beats ?? NO_BEATS} downbeats={motion?.audio?.downbeats ?? NO_BEATS}
      onTogglePlay={togglePlay} onSeek={seek} />
    <audio ref={audioRef} src={audioUrl ?? undefined} onEnded={() => setPlaying(false)} />
    <input ref={songInputRef} type="file" accept="audio/*" onChange={(event) => void onFile(event)} disabled={uploadDisabled} hidden aria-label="Upload song" />
    <input ref={characterInputRef} type="file" accept=".glb,.gltf,.fbx" onChange={onCharacterFile} hidden aria-label="Upload character" />
    <GeneratorSettings connection={connection} disabled={busy || !!job || cancelling} open={generatorOpen} onClose={() => setGeneratorOpen(false)}
      onConnect={(next, info) => { setConnection(next); setGeneratorInfo(info); }} />
  </div>;
}
