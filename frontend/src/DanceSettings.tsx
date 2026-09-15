import { memo, useId } from 'react';
import type { CSSProperties } from 'react';
import type { Params } from './core/retargetCore';
import Icon from './Icon';

const percent = (value: number) => `${Math.round(value * 100)}%`;

export default memo(function DanceSettings({ count, variation, params, onCount, onVariation, onParam, onClose }: {
  count: number; variation: number; params: Params;
  onCount: (value: number) => void; onVariation: (value: number) => void;
  onParam: (key: 'rootUpright' | 'footLock' | 'recenterWin', value: number) => void;
  onClose: () => void;
}) {
  return <aside className="inspector" id="dance-settings" aria-labelledby="settings-title">
    <div className="inspector-heading">
      <h2 id="settings-title">Adjust dance</h2>
      <button className="icon-button" aria-label="Close dance settings" onClick={onClose}><Icon name="close" /></button>
    </div>
    <p className="section-description">Fine-tune the performance, live.</p>
    <div className="control-group">
      <Slider label="Dancers" value={count} min={1} max={400} step={1} onChange={onCount} />
      <Slider label="Variation" description="Offset the timing between dancers." value={variation}
        min={0} max={1} step={0.05} onChange={onVariation} fmt={percent} />
    </div>
    <details className="advanced-settings">
      <summary><span>Motion cleanup</span><Icon name="chevron" /></summary>
      <div className="control-group">
        <Slider label="Upright" description="Keep the body standing tall." value={params.rootUpright}
          min={0} max={1} step={0.05} onChange={(value) => onParam('rootUpright', value)} fmt={percent} />
        <Slider label="Foot lock" description="Reduce sliding when feet are planted." value={params.footLock}
          min={0} max={1} step={0.05} onChange={(value) => onParam('footLock', value)} fmt={percent} />
        <Slider label="Recenter" description="Smooth movement around the center." value={params.recenterWin}
          min={1} max={121} step={2} onChange={(value) => onParam('recenterWin', value)} />
      </div>
    </details>
  </aside>;
});

function Slider({ label, description, value, min, max, step, onChange, fmt }: {
  label: string; description?: string; value: number; min: number; max: number; step: number;
  onChange: (value: number) => void; fmt?: (value: number) => string;
}) {
  const id = useId();
  const formatted = fmt ? fmt(value) : String(value);
  return <div className="slider-control">
    <div className="slider-label"><label htmlFor={id}>{label}</label><output htmlFor={id}>{formatted}</output></div>
    <input id={id} type="range" min={min} max={max} step={step} value={value}
      aria-valuetext={formatted} aria-describedby={description ? `${id}-hint` : undefined}
      onChange={(event) => onChange(Number(event.target.value))}
      style={{ '--range-progress': `${(value - min) / (max - min) * 100}%` } as CSSProperties} />
    {description && <p id={`${id}-hint`} className="control-hint">{description}</p>}
  </div>;
}
