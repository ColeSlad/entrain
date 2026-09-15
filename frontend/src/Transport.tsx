import { memo, type CSSProperties } from 'react';
import Icon from './Icon';

// The audio remains the master clock. Beat markers are static while it plays.
export default function Transport({
  playing, currentTime, duration, beats, downbeats, songName, enabled, isDemo = false, onTogglePlay, onSeek,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  beats: number[];
  downbeats: number[];
  songName: string;
  enabled: boolean;
  isDemo?: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
}) {
  const progress = duration > 0 ? Math.min(currentTime / duration, 1) * 100 : 0;
  return <footer className={`transport ${!enabled ? 'transport-empty' : ''}`} aria-label="Music playback">
    <div className="song-info">
      <span className="song-icon"><Icon name="music" /></span>
      <div className="song-copy">
        <span className="song-title" title={songName || undefined}>{songName || 'Your music starts here'}</span>
        <span className="song-detail">{isDemo ? 'Saved demo · ' : ''}{enabled ? playing ? 'Playing' : 'Paused' : 'No generator needed for the demo'}</span>
      </div>
    </div>
    <div className="playback-controls">
      <button className="icon-button restart-button" disabled={!enabled} onClick={() => onSeek(0)} aria-label="Back to start" title="Back to start"><Icon name="restart" /></button>
      <button className="play-button" disabled={!enabled} onClick={onTogglePlay} aria-label={playing && enabled ? 'Pause' : 'Play'} title={playing && enabled ? 'Pause (Space)' : 'Play (Space)'}>
        <Icon name={playing && enabled ? 'pause' : 'play'} />
      </button>
    </div>
    <div className="timeline">
      <BeatMarkers duration={duration} beats={beats} downbeats={downbeats} />
      <input type="range" aria-label="Playback position" aria-valuetext={`${fmt(currentTime)} of ${fmt(duration)}`}
        min={0} max={duration || 0} step={0.01} value={Math.min(currentTime, duration || 0)} disabled={!enabled}
        onChange={(event) => onSeek(Number(event.target.value))}
        style={{ '--range-progress': `${progress}%` } as CSSProperties} />
    </div>
    <div className="playback-time"><span>{fmt(currentTime)}</span><span className="time-divider">/</span><span>{fmt(duration)}</span></div>
  </footer>;
}

const BeatMarkers = memo(function BeatMarkers({ duration, beats, downbeats }: {
  duration: number; beats: number[]; downbeats: number[];
}) {
  return <div className="beat-markers" aria-hidden="true">
    {duration > 0 && beats.map((time, index) => time <= duration
      ? <span key={`b${index}`} style={{ left: `${time / duration * 100}%` }} /> : null)}
    {duration > 0 && downbeats.map((time, index) => time <= duration
      ? <span className="downbeat" key={`d${index}`} style={{ left: `${time / duration * 100}%` }} /> : null)}
  </div>;
});

function fmt(seconds: number): string {
  if (!isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}
