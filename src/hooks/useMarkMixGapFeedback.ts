import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { applyFeedbackToMixGap, type MixGapStatus } from '@/lib/mixgap/feedback';
import { track } from '@/lib/analytics';
import type { MixGap } from '@/hooks/useMyMixGap';

interface MarkArgs { customerUserId: string; familia: string; status: MixGapStatus; }

/** Marca um gap como ofertado/convertido/recusado. Optimistic sobre ['my-mixgap', effectiveUserId].
 * O write é sempre seller=auth.uid() na RPC; effectiveUserId só na queryKey de leitura. */
export function useMarkMixGapFeedback() {
  const qc = useQueryClient();
  const { effectiveUserId } = useImpersonation();
  const key = ['my-mixgap', effectiveUserId];
  return useMutation({
    mutationFn: async ({ customerUserId, familia, status }: MarkArgs) => {
      const client = supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
      };
      const { error } = await client.rpc('mark_mixgap_feedback', {
        p_customer: customerUserId, p_familia: familia, p_status: status,
      });
      if (error) throw new Error(error.message);
    },
    onMutate: async ({ customerUserId, familia, status }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MixGap | null>(key);
      if (prev) qc.setQueryData<MixGap>(key, applyFeedbackToMixGap(prev, customerUserId, familia, status));
      track('carteira.mixgap_feedback', { status });
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: key }); },
  });
}
