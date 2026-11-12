import type { ComponentChildren } from 'preact';
import type { IconName } from './db';

export type IconId =
  | IconName
  | 'conn'
  | 'connOn'
  | 'sql'
  | 'play'
  | 'add'
  | 'more'
  | 'menu'
  | 'refresh'
  | 'close'
  | 'chevron'
  | 'pg'
  | 'mongo'
  | 'sqlite';

const cyl = (
  <>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
  </>
);

const folder = 'M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2.5h7.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z';
const grid = (
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M3 10h18M9.5 10v9.5" />
  </>
);

const draw: Record<IconId, ComponentChildren> = {
  db: cyl,
  conn: cyl,
  connOn: (
    <>
      {cyl}
      <circle class="dot-on" cx="18.5" cy="18.5" r="3.5" />
    </>
  ),
  schema: (
    <>
      <path d={folder} />
      <path d="M3 10.5h18" />
    </>
  ),
  folder: <path d={folder} />,
  table: grid,
  view: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" stroke-dasharray="3 2" />
      <path d="M3 10h18M9.5 10v9.5" />
    </>
  ),
  collection: (
    <>
      <rect x="3.5" y="3.5" width="12" height="12" rx="2" />
      <path d="M8.5 20.5h10a2 2 0 0 0 2-2v-10" />
    </>
  ),
  sql: <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M8.5 13h7M8.5 17h4" />,
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" />,
  add: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  pg: cyl,
  mongo: <path d="M12 2.5c4 4 5.5 8.5 0 17-5.5-8.5-4-13 0-17zM12 12v9" />,
  sqlite: <path d="M6 3h9l3 3v15H6zM9 16c0-4 2-7 6-8.5" />,
};

export function Icon({ n }: { n: IconId }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      {draw[n]}
    </svg>
  );
}
