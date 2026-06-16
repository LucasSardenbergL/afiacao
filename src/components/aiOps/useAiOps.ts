// Hooks de dados + composição de estado/derivados do AI Ops.
// Extraído verbatim de src/pages/AIops.tsx (god-component split):
// queries (decisões/perfis), mutations (rodar agente/atualizar status),
// filtros e particionamento prioridades/oportunidades/riscos.
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { AIDecision, CustomerProfileLite } from './types';

function useAIDecisions() {
  return useQuery({
    queryKey: ['ai-decisions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ai_decisions')
        .select('*')
        .order('score_final', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as unknown as AIDecision[];
    },
  });
}

function useCustomerProfiles(customerIds: string[]) {
  return useQuery({
    queryKey: ['ai-ops-profiles', customerIds.join(',')],
    queryFn: async () => {
      if (!customerIds.length) return [];
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, document, phone, email, customer_type')
        .in('user_id', customerIds);
      if (error) throw error;
      return (data || []) as unknown as CustomerProfileLite[];
    },
    enabled: customerIds.length > 0,
  });
}

function useRunAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('ai-ops-agent');
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-decisions'] });
      toast.success(`Agente executado: ${data?.decisions_generated || 0} decisões geradas`);
    },
    onError: (error) => {
      toast.error(`Erro ao executar agente: ${error.message}`);
    },
  });
}

function useUpdateDecisionStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase
        .from('ai_decisions')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-decisions'] });
    },
  });
}

export function useAiOps() {
  const [confidenceFilter, setConfidenceFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState('prioridades');

  const { data: decisions = [], isLoading } = useAIDecisions();
  const runAgent = useRunAgent();
  const updateStatus = useUpdateDecisionStatus();

  const customerIds = useMemo(
    () => [...new Set(decisions.map((d) => d.customer_user_id))],
    [decisions]
  );
  const { data: profiles = [] } = useCustomerProfiles(customerIds);
  const profileMap = useMemo(
    () => new Map(profiles.map((p) => [p.user_id, p])),
    [profiles]
  );

  // ─── Filtered lists ───
  const filtered = useMemo(() => {
    let list = decisions;
    if (confidenceFilter !== 'all') {
      list = list.filter((d) => d.confidence === confidenceFilter);
    }
    return list;
  }, [decisions, confidenceFilter]);

  // Prioridades: pending decisions sorted by score
  const prioridades = filtered.filter((d) => d.status === 'pending');

  // Oportunidades: customers with good metrics but could buy more (expansion)
  // null/undefined em métrica → 0 (reproduz a coerção numérica implícita do JS:
  // `null > 0` é false, `null < 1.5` é true; o guard de faturamento>0 vem primeiro).
  const oportunidades = filtered.filter(
    (d) =>
      d.status === 'pending' &&
      (d.customer_metrics?.faturamento_90d ?? 0) > 0 &&
      (d.customer_metrics?.atraso_relativo ?? 0) < 1.5
  );

  // Riscos: high churn risk (atraso >= 2x or big revenue drop)
  const riscos = filtered.filter(
    (d) =>
      d.status === 'pending' &&
      ((d.customer_metrics?.atraso_relativo ?? 0) >= 2.0 ||
        ((d.customer_metrics?.faturamento_prev_90d ?? 0) > 0 &&
          (d.customer_metrics?.faturamento_90d ?? 0) <
            (d.customer_metrics?.faturamento_prev_90d ?? 0) * 0.5))
  );

  return {
    confidenceFilter,
    setConfidenceFilter,
    activeTab,
    setActiveTab,
    isLoading,
    profileMap,
    prioridades,
    oportunidades,
    riscos,
    isRunningAgent: runAgent.isPending,
    runAgent: () => runAgent.mutate(),
    accept: (id: string) => updateStatus.mutate({ id, status: 'accepted' }),
    dismiss: (id: string) => updateStatus.mutate({ id, status: 'dismissed' }),
  };
}
