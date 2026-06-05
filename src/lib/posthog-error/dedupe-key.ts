const norm = (s: string | null | undefined): string => (s ?? '').toString().trim() || '_';

/** Chave de idempotência por issue do PostHog: project:issue:action. */
export function buildDedupeKey(parts: {
  projectId?: string | null;
  issueId?: string | null;
  action?: string | null;
}): string {
  return `${norm(parts.projectId)}:${norm(parts.issueId)}:${norm(parts.action)}`;
}

/** Chave do rollup anti-tempestade: 1 bucket por janela de 30min (determinístico, recebe o instante). */
export function buildRollupKey(nowIso: string): string {
  const ms = new Date(nowIso).getTime();
  const bucket = Math.floor(ms / (30 * 60 * 1000));
  return `rollup:${bucket}`;
}
