import type { CSSProperties } from 'react';

// Play/pause and scrub, in song seconds, with beat markers above the bar.
// Stateless: App owns the audio clock.
export default function Transport({
  playing, currentTime, duration, beats, downbeats, onTogglePlay, onSeek,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  beats: number[];
  downbeats: number[];
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
}) {
  return (
    <div style={bar}>
      <button onClick={onTogglePlay} style={btn}>{playing ? 'Pause' : 'Play'}</button>
      <div style={track}>
        <div style={tickRow}>
          {duration > 0 && beats.map((t, i) =>
            t <= duration ? <span key={`b${i}`} style={tickStyle(t / duration, false)} /> : null)}
          {duration > 0 && downbeats.map((t, i) =>
            t <= duration ? <span key={`d${i}`} style={tickStyle(t / duration, true)} /> : null)}
        </div>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => onSeek(Number(e.target.value))}
          style={{ width: '100%', display: 'block' }}
        />
      </div>
      <span style={time}>{fmt(currentTime)} / {fmt(duration)}</span>
    </div>
  );
}

function fmt(s: number): string {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function tickStyle(frac: number, down: boolean): CSSProperties {
  return {
    position: 'absolute', left: `${frac * 100}%`, transform: 'translateX(-50%)',
    bottom: 0, width: down ? 2 : 1, height: down ? 8 : 5,
    background: down ? '#ffffff' : '#6b6f76',
  };
}

const bar: CSSProperties = {
  position: 'fixed', left: 12, right: 12, bottom: 12, display: 'flex', gap: 12,
  alignItems: 'center', fontFamily: 'system-ui, sans-serif', fontSize: 13,
  color: '#cfd2d6', background: 'rgba(20,22,26,0.7)', padding: '8px 12px', borderRadius: 8,
};
const btn: CSSProperties = {
  background: '#aa3bff', color: 'white', border: 'none', padding: '6px 14px',
  borderRadius: 6, cursor: 'pointer', minWidth: 64,
};
const track: CSSProperties = { flex: 1, position: 'relative', paddingTop: 8 };
const tickRow: CSSProperties = { position: 'absolute', left: 0, right: 0, top: 0, height: 8, pointerEvents: 'none' };
const time: CSSProperties = { fontVariantNumeric: 'tabular-nums', minWidth: 90, textAlign: 'right' };
