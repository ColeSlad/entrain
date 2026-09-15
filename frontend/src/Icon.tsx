import type { CSSProperties } from 'react';

type IconName = 'music' | 'upload' | 'download' | 'person' | 'tune' | 'close' |
  'chevron' | 'play' | 'pause' | 'restart' | 'check' | 'connection' | 'alert';

const paths: Record<IconName, string> = {
  music: 'M9 18V5l11-2v13M9 9l11-2M9 18c0 1.7-1.6 3-3.5 3S2 20 2 18.5 3.6 16 5.5 16 9 16.7 9 18Zm11-2c0 1.7-1.6 3-3.5 3S13 18 13 16.5s1.6-2.5 3.5-2.5 3.5.7 3.5 2Z',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
  download: 'M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  person: 'M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  tune: 'M4 6h4m4 0h8M4 18h10m4 0h2M10 3v6M16 15v6M4 12h10m4 0h2M16 9v6',
  close: 'm6 6 12 12M6 18 18 6',
  chevron: 'm9 5 7 7-7 7',
  play: 'm8 5 11 7-11 7Z',
  pause: 'M8 5v14M16 5v14',
  restart: 'M4 10a8 8 0 1 1 1 7M4 4v6h6',
  check: 'm5 12 4 4L19 6',
  connection: 'm8 12 8-8m-4-1 9 9M7 7l10 10M5 9l-2 2a5 5 0 0 0 7 7l2-2M2 22l3-3',
  alert: 'M12 8v5m0 4h.01M10.3 3.9 2.1 18a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
};

export default function Icon({ name, className = '', style }: {
  name: IconName; className?: string; style?: CSSProperties;
}) {
  return <svg className={`icon ${className}`} style={style} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"><path d={paths[name]} /></svg>;
}
