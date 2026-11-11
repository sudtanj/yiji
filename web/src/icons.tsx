import type { ComponentChildren } from 'preact';
import type { IconName } from './db';

export type IconId =
  | IconName
  | 'conn'
  | 'connOn'
  | 'newConn'
  | 'plug'
  | 'unplug'
  | 'sql'
  | 'play'
  | 'lock'
  | 'save'
  | 'menu'
  | 'refresh'
  | 'close'
  | 'chevron'
  | 'pg'
  | 'mongo'
  | 'sqlite';

const cyl = (fill: string, stroke: string) => (
  <>
    <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" fill={fill} stroke={stroke} />
    <ellipse cx="8" cy="4" rx="5" ry="2" fill={fill} stroke={stroke} />
    <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" fill="none" stroke={stroke} />
  </>
);

const draw: Record<IconId, ComponentChildren> = {
  db: cyl('#dbe7f3', '#2f5d8c'),
  conn: cyl('#e6e6e6', '#777'),
  connOn: (
    <>
      {cyl('#dbe7f3', '#2f5d8c')}
      <circle cx="12.5" cy="12.5" r="3" fill="#2e9d44" stroke="#fff" />
    </>
  ),
  newConn: (
    <>
      {cyl('#dbe7f3', '#2f5d8c')}
      <circle cx="12" cy="12" r="3.5" fill="#2e9d44" />
      <path d="M12 10v4M10 12h4" stroke="#fff" />
    </>
  ),
  schema: <path d="M2 4h4l1 1.5h7V13H2z" fill="#dbe7f3" stroke="#2f5d8c" />,
  folder: <path d="M2 4h4l1 1.5h7V13H2z" fill="#f3dc9a" stroke="#a07a1a" />,
  table: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" fill="#fff" stroke="#2f5d8c" />
      <path d="M2.5 3.5h11v3h-11z" fill="#9db9d8" stroke="#2f5d8c" />
      <path d="M2.5 9.5h11M7 6.5v6" stroke="#2f5d8c" />
    </>
  ),
  view: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" fill="#fff" stroke="#2f5d8c" stroke-dasharray="2 1" />
      <path d="M2.5 6.5h11M7 6.5v6" stroke="#2f5d8c" />
    </>
  ),
  collection: (
    <>
      <rect x="2.5" y="2.5" width="8" height="8" fill="#e3f1e5" stroke="#3a8a4a" />
      <rect x="5.5" y="5.5" width="8" height="8" fill="#fff" stroke="#3a8a4a" />
      <path d="M7.5 8.5h4M7.5 10.5h4" stroke="#3a8a4a" />
    </>
  ),
  plug: <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" fill="none" stroke="#444" />,
  unplug: (
    <>
      <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" fill="none" stroke="#444" />
      <path d="M2.5 2.5l11 11" stroke="#c0392b" stroke-width="1.5" />
    </>
  ),
  sql: (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="#fff" stroke="#555" />
      <path d="M9.5 1.5v3h3M5.5 8h5M5.5 10h5M5.5 12h3" fill="none" stroke="#2f5d8c" />
    </>
  ),
  play: <path d="M4.5 3l8 5-8 5z" fill="#2e9d44" stroke="#1f6e2f" />,
  lock: (
    <>
      <rect x="3.5" y="7.5" width="9" height="6" fill="#e8c860" stroke="#8a6d1a" />
      <path d="M5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="#555" />
    </>
  ),
  save: (
    <>
      <path d="M2.5 2.5h9l2 2v9h-11z" fill="#9db9d8" stroke="#2f5d8c" />
      <rect x="5" y="2.5" width="5" height="3.5" fill="#fff" stroke="#2f5d8c" />
      <rect x="4.5" y="9" width="7" height="4.5" fill="#fff" stroke="#2f5d8c" />
    </>
  ),
  menu: <path d="M2 4h12M2 8h12M2 12h12" stroke="#333" stroke-width="1.5" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" fill="none" stroke="#2e7d32" stroke-width="1.5" />
      <path d="M13 2v3.5H9.5" fill="#2e7d32" stroke="#2e7d32" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" stroke="#555" stroke-width="1.5" />,
  chevron: <path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="#555" stroke-width="1.5" />,
  pg: cyl('#cfe0f2', '#336791'),
  mongo: <path d="M8 1.5c3.2 3 4.2 6.5 0 13-4.2-6.5-3.2-10 0-13zM8 9v5.5" fill="#c9e6cd" stroke="#3a8a4a" />,
  sqlite: (
    <>
      <path d="M3.5 1.5h7l2 2v11h-9z" fill="#d6eaf3" stroke="#1c7ea0" />
      <path d="M6 12c0-4 1.5-7 5-8.5" fill="none" stroke="#1c7ea0" stroke-width="1.5" />
    </>
  ),
};

export function Icon({ n }: { n: IconId }) {
  return (
    <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
      {draw[n]}
    </svg>
  );
}
