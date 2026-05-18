export type DiffRow = {
  field: string;
  before?: unknown;
  after?: unknown;
};

export function formatAuditDiff(
  op: 'INSERT' | 'UPDATE' | 'DELETE',
  changedFields: Record<string, unknown>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [field, val] of Object.entries(changedFields)) {
    if (op === 'UPDATE' && val && typeof val === 'object' && 'before' in val && 'after' in val) {
      const v = val as { before: unknown; after: unknown };
      rows.push({ field, before: v.before, after: v.after });
    } else if (op === 'INSERT') {
      rows.push({ field, after: val });
    } else if (op === 'DELETE') {
      rows.push({ field, before: val });
    }
  }
  return rows.sort((a, b) => a.field.localeCompare(b.field));
}

const ORIGEM_LABELS: Record<string, string> = {
  manual: 'Manual',
  omie_sync: 'Sync Omie',
  edge_fn: 'Serviço interno',
  override_emergencia: 'Override emergência',
  cron: 'Cron agendado',
  trigger: 'Trigger automático',
};

export function formatAuditOrigem(origem: string): string {
  return ORIGEM_LABELS[origem] ?? origem;
}

export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  }
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
