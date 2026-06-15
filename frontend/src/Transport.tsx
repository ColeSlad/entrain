import type { CSSProperties } from 'react';

// Play/pause and scrub. Stateless: App owns the playback state and frame.
export default function Transport({
  playing, frame, numFrames, fps, onTogglePlay, onSeek,
}: {
  playing: boolean;
  frame: number;
  numFrames: number;
  fps: number;
  onTogglePlay: () => void;
  onSeek: (frame: number) => void;
}) {
  const at = (frame / fps).toFixed(1);
  const total = (numFrames / fps).toFixed(1);
  return (
    <div style={bar}>
      <button onClick={onTogglePlay} style={btn}>{playing ? 'Pause' : 'Play'}</button>
      <input
        type="range"
        min={0}
        max={Math.max(0, numFrames - 1)}
        step={1}
        value={Math.floor(frame)}
        onChange={(e) => onSeek(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={time}>{at}s / {total}s</span>
    </div>
  );
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
const time: CSSProperties = { fontVariantNumeric: 'tabular-nums', minWidth: 90, textAlign: 'right' };
