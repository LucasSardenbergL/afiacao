import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

type LinhaAudit = Tables<'fin_audit_log'>;

// Espelham os CHECKs de `fin_audit_log.op` / `.origem` (conferidos na prod em 2026-10-19).
const OPS = ['INSERT', 'UPDATE', 'DELETE'] as const;
const ORIGENS = ['manual', 'omie_sync', 'edge_fn', 'override_emergencia', 'cron', 'trigger'] as const;

export type AuditEntry = Omit<LinhaAudit, 'op' | 'origem' | 'changed_fields'> & {
  op: (typeof OPS)[number];
  origem: (typeof ORIGENS)[number];
  changed_fields: Record<string, unknown>;
};

function umDe<T extends string>(lista: readonly T[], v: string): v is T {
  return (lista as readonly string[]).includes(v);
}

/** Borda: `op`/`origem` fora do CHECK e `changed_fields` que não é objeto LANÇAM — nunca badge inventado. */
function paraAuditEntry(l: LinhaAudit): AuditEntry {
  if (!umDe(OPS, l.op)) throw new Error(`fin_audit_log#${l.id}: op "${l.op}" fora do vocabulário`);
  if (!umDe(ORIGENS, l.origem)) throw new Error(`fin_audit_log#${l.id}: origem "${l.origem}" fora do vocabulário`);
  const cf = l.changed_fields;
  if (cf === null || typeof cf !== 'object' || Array.isArray(cf)) {
    throw new Error(`fin_audit_log#${l.id}: changed_fields não é um objeto`);
  }
  return { ...l, op: l.op, origem: l.origem, changed_fields: cf };
}

export function useAuditTrail(params: { tableName: string; rowId: string; limit?: number }) {
  const { tableName, rowId, limit = 50 } = params;
  return useQuery({
    queryKey: ['fin_audit_log', tableName, rowId, limit],
    enabled: Boolean(tableName) && Boolean(rowId),
    queryFn: async (): Promise<AuditEntry[]> => {
      const { data, error } = await supabase
        .from('fin_audit_log')
        .select('*')
        .eq('table_name', tableName)
        .eq('row_id', rowId)
        .order('changed_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(paraAuditEntry);
    },
  });
}
