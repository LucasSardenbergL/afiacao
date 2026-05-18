import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AuditEntry = {
  id: number;
  table_name: string;
  row_id: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  changed_fields: Record<string, unknown>;
  changed_by: string | null;
  changed_at: string;
  company: string | null;
  origem: 'manual' | 'omie_sync' | 'edge_fn' | 'override_emergencia' | 'cron' | 'trigger';
  period_ref: string | null;
  override_justificativa: string | null;
};

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
      return (data ?? []) as AuditEntry[];
    },
  });
}
