// Hook de dados/estado do AdminNotificacoes.
// Extraído verbatim de src/pages/AdminNotificacoes.tsx (god-component split):
// 3 queries (pendentes/histórico/stats30) + mutation de disparo + memos de
// filtros, estatísticas e dados do gráfico.
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { SELECT_COLUMNS } from './format';
import type { AlertaRow } from './types';

export function useNotificacoes() {
  const qc = useQueryClient();
  const [drawerAlerta, setDrawerAlerta] = useState<AlertaRow | null>(null);

  const [filtroSev, setFiltroSev] = useState<string>('__all__');
  const [filtroEmpresa, setFiltroEmpresa] = useState<string>('__all__');
  const [filtroTipo, setFiltroTipo] = useState<string>('__all__');

  // Pendentes
  const { data: pendentes, isLoading: loadingPend } = useQuery({
    queryKey: ['notificacoes', 'pendentes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fornecedor_alerta')
        .select(SELECT_COLUMNS)
        .eq('status', 'pendente_notificacao')
        .order('criado_em', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as unknown as AlertaRow[];
    },
    refetchInterval: 30_000,
  });

  // Histórico (30 dias)
  const { data: historico, isLoading: loadingHist } = useQuery({
    queryKey: ['notificacoes', 'historico'],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('fornecedor_alerta')
        .select(SELECT_COLUMNS)
        .in('status', ['notificado', 'falha_notificacao'])
        .gte('criado_em', since)
        .order('notificado_em', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return data as unknown as AlertaRow[];
    },
    refetchInterval: 60_000,
  });

  // Estatísticas (30 dias completos para gráfico)
  const { data: stats30, isLoading: loadingStats } = useQuery({
    queryKey: ['notificacoes', 'stats30'],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('fornecedor_alerta')
        .select('id, status, criado_em, tentativas')
        .gte('criado_em', since)
        .limit(5000);
      if (error) throw error;
      return data as Array<{ id: number; status: string | null; criado_em: string; tentativas: number | null }>;
    },
    refetchInterval: 60_000,
  });

  const dispatchMut = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('dispatch-notifications', {
        body: {},
      });
      if (error) throw error;
      return data as { processados: number; sucesso?: number; falhas?: number };
    },
    onSuccess: (data) => {
      const proc = data?.processados ?? 0;
      const ok = data?.sucesso ?? 0;
      const fail = data?.falhas ?? 0;
      toast.success(`${proc} processados, ${ok} sucesso, ${fail} falhas`);
      qc.invalidateQueries({ queryKey: ['notificacoes'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao disparar: ${msg}`);
    },
  });

  // Opções dos filtros (derivadas de pendentes)
  const empresasOpts = useMemo(
    () => Array.from(new Set((pendentes ?? []).map((a) => a.empresa).filter(Boolean))),
    [pendentes],
  );
  const tiposOpts = useMemo(
    () => Array.from(new Set((pendentes ?? []).map((a) => a.tipo).filter(Boolean))),
    [pendentes],
  );

  const pendentesFiltrados = useMemo(() => {
    return (pendentes ?? []).filter((a) => {
      if (filtroSev !== '__all__' && a.severidade !== filtroSev) return false;
      if (filtroEmpresa !== '__all__' && a.empresa !== filtroEmpresa) return false;
      if (filtroTipo !== '__all__' && a.tipo !== filtroTipo) return false;
      return true;
    });
  }, [pendentes, filtroSev, filtroEmpresa, filtroTipo]);

  // Stats
  const total7d = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    return (stats30 ?? []).filter((a) => new Date(a.criado_em).getTime() >= cutoff).length;
  }, [stats30]);

  const taxaSucesso = useMemo(() => {
    const finais = (stats30 ?? []).filter((a) => a.status === 'notificado' || a.status === 'falha_notificacao');
    if (finais.length === 0) return 0;
    const ok = finais.filter((a) => a.status === 'notificado').length;
    return Math.round((ok / finais.length) * 100);
  }, [stats30]);

  const esgotados = useMemo(() => {
    return (stats30 ?? []).filter((a) => a.status === 'falha_notificacao' && (a.tentativas ?? 0) >= 3).length;
  }, [stats30]);

  // Stack chart data por dia
  const chartData = useMemo(() => {
    const buckets: Record<string, { dia: string; notificado: number; pendente: number; falha: number }> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600_000);
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { dia: key.slice(5), notificado: 0, pendente: 0, falha: 0 };
    }
    for (const a of stats30 ?? []) {
      const key = a.criado_em.slice(0, 10);
      const b = buckets[key];
      if (!b) continue;
      if (a.status === 'notificado') b.notificado++;
      else if (a.status === 'falha_notificacao') b.falha++;
      else b.pendente++;
    }
    return Object.values(buckets);
  }, [stats30]);

  return {
    drawerAlerta,
    setDrawerAlerta,
    filtroSev,
    setFiltroSev,
    filtroEmpresa,
    setFiltroEmpresa,
    filtroTipo,
    setFiltroTipo,
    pendentes,
    loadingPend,
    historico,
    loadingHist,
    loadingStats,
    dispatchPending: dispatchMut.isPending,
    dispatch: () => dispatchMut.mutate(),
    empresasOpts,
    tiposOpts,
    pendentesFiltrados,
    total7d,
    taxaSucesso,
    esgotados,
    chartData,
  };
}
