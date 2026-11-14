import type { PrFile, User } from '../types.ts';

const LETTER: Record<PrFile['status'], string> = {
  added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: '·',
};

export function StatusLetter({ status }: { status: PrFile['status'] }) {
  const l = LETTER[status];
  return <span className={`status status-${l}`} title={status}>{l}</span>;
}

export function UserLink({ user }: { user: User | null }) {
  if (!user) return <span className="user">ghost</span>;
  return (
    <a className="user" href={`https://github.com/${user.login}`} target="_blank" rel="noreferrer">
      <img className="avatar" src={user.avatarUrl} alt="" loading="lazy" />
      {user.login}
    </a>
  );
}

export function MiniBar({ a, d, max }: { a: number; d: number; max: number }) {
  const total = a + d;
  const w = max > 0 ? Math.max(total > 0 ? 2 : 0, Math.round((Math.log1p(total) / Math.log1p(max)) * 30)) : 0;
  const aw = total ? Math.round((w * a) / total) : 0;
  return (
    <span className="minibar" title={`+${a} −${d}`}>
      <i className="a" style={{ width: aw }} />
      <i className="d" style={{ width: w - aw }} />
    </span>
  );
}

export function relTime(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
