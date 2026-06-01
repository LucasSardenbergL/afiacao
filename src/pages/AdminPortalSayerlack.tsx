import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { DispararAgoraButton } from '@/components/portalSayerlack/DispararAgoraButton';
import { PortalDetailDrawer } from '@/components/portalSayerlack/PortalDetailDrawer';
import { SAYERLACK_FILTER, PEDIDO_COLS, type PedidoRow } from '@/components/portalSayerlack/types';
import { KpiCards } from '@/components/portalSayerlack/KpiCards';
import { PendentesTab } from '@/components/portalSayerlack/PendentesTab';
import { ConciliarTab } from '@/components/portalSayerlack/ConciliarTab';
import { HistoricoTab } from '@/components/portalSayerlack/HistoricoTab';
import { EstatisticasTab } from '@/components/portalSayerlack/EstatisticasTab';

export default function AdminPortalSayerlack() {
  const { isAdmin, isMaster } = useAuth();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [pendentesBusca, setPendentesBusca] = useState('');
  const [histStatus, setHistStatus] = useState<'todos' | 'enviados' | 'falhas'>('todos');
  const [conciliacaoBusca, setConciliacaoBusca] = useState('');
  const [histRange, setHistRange] = useState<'7' | '30' | '90'>('30');
  const [histBusca, setHistBusca] = useState('');

  // ---------- KPIs ----------
  const { data: kpis } = useQuery({
    queryKey: ['portal-sayerlack-kpi'],
    queryFn: async () => {
      const base = supabase
        .from('pedido_compra_sugerido')
        .select('id, status_envio_portal, enviado_portal_em, criado_em', { count: 'exact', head: false })
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike);

      // Pendentes (status disparado + portal aguardando: novo erro_retentavel
      // entra na fila junto com pendente/enviando)
      const { count: pendentes } = await supabase
        .from('pedido_compra_sugerido')
        .select('*', { count: 'exact', head: true })
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .eq('status', 'disparado')
        .in('status_envio_portal', ['pendente_envio_portal', 'enviando_portal', 'erro_retentavel']);

      // Requer conciliação manual (estado novo introduzido pelo PR1)
      const { count: conciliacao } = await supabase
        .from('pedido_compra_sugerido')
        .select('*', { count: 'exact', head: true })
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao']);

      // Enviados últimos 7d (legado enviado_portal + novo sucesso_portal)
      const seteDias = new Date(Date.now() - 7 * 86400000).toISOString();
      const { count: enviados7d } = await supabase
        .from('pedido_compra_sugerido')
        .select('*', { count: 'exact', head: true })
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['enviado_portal', 'sucesso_portal'])
        .gte('enviado_portal_em', seteDias);

      // Taxa sucesso 30d (sucessos: enviado_portal + sucesso_portal;
      // falhas: falha_envio_portal + erro_nao_retentavel)
      const trintaDias = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: rows30d } = await supabase
        .from('pedido_compra_sugerido')
        .select('status_envio_portal, enviado_portal_em, criado_em')
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['enviado_portal', 'sucesso_portal', 'falha_envio_portal', 'erro_nao_retentavel'])
        .gte('criado_em', trintaDias);

      const total = (rows30d ?? []).length;
      const ok = (rows30d ?? []).filter(
        (r) => r.status_envio_portal === 'enviado_portal' || r.status_envio_portal === 'sucesso_portal',
      ).length;
      const taxa = total === 0 ? null : Math.round((ok / total) * 1000) / 10;

      void base;
      return { pendentes: pendentes ?? 0, conciliacao: conciliacao ?? 0, enviados7d: enviados7d ?? 0, taxa };
    },
    refetchInterval: 30_000,
  });

  // ---------- Pendentes ----------
  const { data: pendentes, isLoading: loadingPend } = useQuery({
    queryKey: ['portal-sayerlack-pendentes', pendentesBusca],
    queryFn: async () => {
      const q = supabase
        .from('pedido_compra_sugerido')
        .select(PEDIDO_COLS)
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['pendente_envio_portal', 'enviando_portal', 'erro_retentavel'])
        .order('aprovado_em', { ascending: true })
        .limit(200);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as PedidoRow[];
    },
    // Polling adaptativo: 5s enquanto houver pedido em processamento (background
    // do envio assíncrono), 30s caso contrário.
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as PedidoRow[];
      const hasProcessing = rows.some((r) => r.status_envio_portal === 'enviando_portal');
      return hasProcessing ? 5_000 : 30_000;
    },
  });

  // ---------- Conciliação manual (PR1.5) ----------
  const { data: conciliacao, isLoading: loadingConciliacao } = useQuery({
    queryKey: ['portal-sayerlack-conciliacao'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pedido_compra_sugerido')
        .select(PEDIDO_COLS)
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao'])
        .order('aprovado_em', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as PedidoRow[];
    },
    refetchInterval: 30_000,
  });

  // ---------- Histórico ----------
  const { data: historico, isLoading: loadingHist } = useQuery({
    queryKey: ['portal-sayerlack-historico', histStatus, histRange],
    queryFn: async () => {
      const dias = parseInt(histRange, 10);
      const desde = new Date(Date.now() - dias * 86400000).toISOString();
      let q = supabase
        .from('pedido_compra_sugerido')
        .select(PEDIDO_COLS)
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .gte('criado_em', desde)
        .order('enviado_portal_em', { ascending: false, nullsFirst: false })
        .limit(500);

      // Histórico = estados terminais (enviado_portal + sucesso_portal + falha_envio_portal + erro_nao_retentavel)
      const HIST_SUCESSO = ['enviado_portal', 'sucesso_portal'];
      const HIST_FALHA = ['falha_envio_portal', 'erro_nao_retentavel'];
      if (histStatus === 'enviados') {
        q = q.in('status_envio_portal', HIST_SUCESSO);
      } else if (histStatus === 'falhas') {
        q = q.in('status_envio_portal', HIST_FALHA);
      } else {
        q = q.in('status_envio_portal', [...HIST_SUCESSO, ...HIST_FALHA]);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as PedidoRow[];
    },
    refetchInterval: 30_000,
  });

  // ---------- Estatísticas ----------
  const { data: stats } = useQuery({
    queryKey: ['portal-sayerlack-stats'],
    queryFn: async () => {
      const desde = new Date(Date.now() - 30 * 86400000).toISOString();
      const SUCESSOS = new Set(['enviado_portal', 'sucesso_portal']);
      const FALHAS = new Set(['falha_envio_portal', 'erro_nao_retentavel']);
      const { data: rows } = await supabase
        .from('pedido_compra_sugerido')
        .select('status_envio_portal, enviado_portal_em, aprovado_em, portal_erro, criado_em')
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', [...SUCESSOS, ...FALHAS])
        .gte('criado_em', desde);

      // Por dia
      const porDia = new Map<string, { dia: string; enviado: number; falha: number }>();
      const tempos: number[] = [];
      const erros = new Map<string, { erro: string; count: number; ultimo: string }>();

      for (const r of rows ?? []) {
        const refDate = r.enviado_portal_em ?? r.criado_em;
        const ehSucesso = SUCESSOS.has(r.status_envio_portal as string);
        const ehFalha = FALHAS.has(r.status_envio_portal as string);
        if (refDate) {
          const dia = new Date(refDate).toISOString().slice(0, 10);
          const cur = porDia.get(dia) ?? { dia, enviado: 0, falha: 0 };
          if (ehSucesso) cur.enviado++;
          else if (ehFalha) cur.falha++;
          porDia.set(dia, cur);
        }
        if (ehSucesso && r.enviado_portal_em && r.aprovado_em) {
          const min = (new Date(r.enviado_portal_em).getTime() - new Date(r.aprovado_em).getTime()) / 60000;
          if (min >= 0) tempos.push(min);
        }
        if (ehFalha && r.portal_erro) {
          const key = r.portal_erro.slice(0, 100);
          const cur = erros.get(key) ?? { erro: key, count: 0, ultimo: r.criado_em ?? '' };
          cur.count++;
          if (new Date(r.criado_em ?? '') > new Date(cur.ultimo)) cur.ultimo = r.criado_em ?? '';
          erros.set(key, cur);
        }
      }

      const bins = [
        { label: '<30min', min: 0, max: 30, count: 0 },
        { label: '30-60min', min: 30, max: 60, count: 0 },
        { label: '1-2h', min: 60, max: 120, count: 0 },
        { label: '2-6h', min: 120, max: 360, count: 0 },
        { label: '6-12h', min: 360, max: 720, count: 0 },
        { label: '12-24h', min: 720, max: 1440, count: 0 },
        { label: '>24h', min: 1440, max: Infinity, count: 0 },
      ];
      for (const m of tempos) {
        const b = bins.find((x) => m >= x.min && m < x.max);
        if (b) b.count++;
      }

      return {
        porDia: Array.from(porDia.values()).sort((a, b) => a.dia.localeCompare(b.dia)),
        bins,
        topErros: Array.from(erros.values()).sort((a, b) => b.count - a.count).slice(0, 10),
      };
    },
    refetchInterval: 60_000,
  });

  // Realtime
  useEffect(() => {
    const ch = supabase
      .channel('portal-sayerlack-realtime')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'pedido_compra_sugerido',
        },
        (payload: { new?: { fornecedor_nome?: string; empresa?: string } }) => {
          const fn = (payload?.new?.fornecedor_nome ?? '').toString().toUpperCase();
          if (payload?.new?.empresa === 'OBEN' && fn.includes('SAYERLACK')) {
            qc.invalidateQueries({ queryKey: ['portal-sayerlack-kpi'] });
            qc.invalidateQueries({ queryKey: ['portal-sayerlack-pendentes'] });
            qc.invalidateQueries({ queryKey: ['portal-sayerlack-conciliacao'] });
            qc.invalidateQueries({ queryKey: ['portal-sayerlack-historico'] });
            qc.invalidateQueries({ queryKey: ['portal-sayerlack-stats'] });
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const openDrawer = (id: number) => {
    setSelectedId(id);
    setDrawerOpen(true);
  };

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-kpi'] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-pendentes'] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-conciliacao'] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-historico'] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-stats'] });
  };

  // CSV Export
  const handleExportCSV = async () => {
    const desde = new Date(Date.now() - 90 * 86400000).toISOString();
    const { data } = await supabase
      .from('pedido_compra_sugerido')
      .select('id, data_ciclo, num_skus, valor_total, status_envio_portal, portal_protocolo, enviado_portal_em, portal_tentativas, portal_erro')
      .eq('empresa', SAYERLACK_FILTER.empresa)
      .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
      .in('status_envio_portal', ['enviado_portal', 'sucesso_portal', 'falha_envio_portal', 'erro_nao_retentavel'])
      .gte('criado_em', desde)
      .order('enviado_portal_em', { ascending: false });

    const header = ['id', 'data_ciclo', 'num_skus', 'valor_total', 'status_envio_portal', 'portal_protocolo', 'enviado_portal_em', 'tentativas', 'portal_erro'];
    const rows = (data ?? []).map((r) => [
      r.id, r.data_ciclo ?? '', r.num_skus ?? '', r.valor_total ?? '',
      r.status_envio_portal ?? '', r.portal_protocolo ?? '',
      r.enviado_portal_em ?? '', r.portal_tentativas ?? 0,
      (r.portal_erro ?? '').replace(/[\r\n,;]+/g, ' '),
    ]);
    const csv = [header.join(','), ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portal-sayerlack-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredPend = useMemo(() => {
    if (!pendentes) return [];
    const q = pendentesBusca.trim().toLowerCase();
    if (!q) return pendentes;
    return pendentes.filter((p) => String(p.id).includes(q));
  }, [pendentes, pendentesBusca]);

  const filteredHist = useMemo(() => {
    if (!historico) return [];
    const q = histBusca.trim().toLowerCase();
    if (!q) return historico;
    return historico.filter((p) => String(p.id).includes(q) || (p.portal_protocolo ?? '').toLowerCase().includes(q));
  }, [historico, histBusca]);

  const filteredConciliacao = useMemo(() => {
    if (!conciliacao) return [];
    const q = conciliacaoBusca.trim().toLowerCase();
    if (!q) return conciliacao;
    return conciliacao.filter((p) => String(p.id).includes(q));
  }, [conciliacao, conciliacaoBusca]);

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Portal Sayerlack — Envio Automático</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitora e dispara o envio dos pedidos OBEN para o portal B2B da Sayerlack.
          </p>
        </div>
        <DispararAgoraButton onSuccess={refetchAll} />
      </div>

      <KpiCards kpis={kpis} />

      <Tabs defaultValue="pendentes">
        <TabsList>
          <TabsTrigger value="pendentes">Pendentes</TabsTrigger>
          <TabsTrigger value="conciliar">
            Conciliar
            {kpis?.conciliacao ? (
              <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-status-warning/20 px-1.5 text-xs font-semibold text-status-warning">
                {kpis.conciliacao}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="estatisticas">Estatísticas</TabsTrigger>
        </TabsList>

        {/* ---------- PENDENTES ---------- */}
        <TabsContent value="pendentes" className="space-y-3">
          <PendentesTab
            loading={loadingPend}
            rows={filteredPend}
            busca={pendentesBusca}
            setBusca={setPendentesBusca}
            onOpenDrawer={openDrawer}
          />
        </TabsContent>

        {/* ---------- CONCILIAR (PR1.5) ---------- */}
        <TabsContent value="conciliar" className="space-y-3">
          <ConciliarTab
            loading={loadingConciliacao}
            rows={filteredConciliacao}
            busca={conciliacaoBusca}
            setBusca={setConciliacaoBusca}
            onOpenDrawer={openDrawer}
          />
        </TabsContent>

        {/* ---------- HISTÓRICO ---------- */}
        <TabsContent value="historico" className="space-y-3">
          <HistoricoTab
            loading={loadingHist}
            rows={filteredHist}
            histStatus={histStatus}
            setHistStatus={setHistStatus}
            histRange={histRange}
            setHistRange={setHistRange}
            histBusca={histBusca}
            setHistBusca={setHistBusca}
            onOpenDrawer={openDrawer}
          />
        </TabsContent>

        {/* ---------- ESTATÍSTICAS ---------- */}
        <TabsContent value="estatisticas" className="space-y-4">
          <EstatisticasTab stats={stats} onExportCSV={handleExportCSV} />
        </TabsContent>
      </Tabs>

      <PortalDetailDrawer
        pedidoId={selectedId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        isAdmin={isAdmin || isMaster}
      />
    </div>
  );
}
