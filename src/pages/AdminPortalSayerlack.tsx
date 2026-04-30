import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Download } from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useUserRole } from '@/hooks/useUserRole';
import { PortalStatusBadge } from '@/components/portalSayerlack/PortalStatusBadge';
import { DispararAgoraButton } from '@/components/portalSayerlack/DispararAgoraButton';
import { PortalDetailDrawer } from '@/components/portalSayerlack/PortalDetailDrawer';
import { Link } from 'react-router-dom';

const SAYERLACK_FILTER = {
  empresa: 'OBEN',
  fornecedorIlike: '%SAYERLACK%',
};

function fmtBRL(v: number | null | undefined) {
  if (v == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));
}
function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}
function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR');
}
function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const past = diff >= 0;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return past ? `há ${min}m` : `em ${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return past ? `há ${h}h` : `em ${h}h`;
  const d = Math.round(h / 24);
  return past ? `há ${d}d` : `em ${d}d`;
}

type PedidoRow = {
  id: number;
  empresa: string;
  fornecedor_nome: string | null;
  data_ciclo: string | null;
  num_skus: number | null;
  valor_total: number | null;
  status: string | null;
  status_envio_portal: string | null;
  aprovado_em: string | null;
  enviado_portal_em: string | null;
  portal_tentativas: number | null;
  portal_proximo_retry_em: string | null;
  portal_protocolo: string | null;
  portal_screenshot_url: string | null;
  portal_erro: string | null;
};

const PEDIDO_COLS =
  'id, empresa, fornecedor_nome, data_ciclo, num_skus, valor_total, status, status_envio_portal, aprovado_em, enviado_portal_em, portal_tentativas, portal_proximo_retry_em, portal_protocolo, portal_screenshot_url, portal_erro';

export default function AdminPortalSayerlack() {
  const { isAdmin, isMaster } = useUserRole();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [pendentesBusca, setPendentesBusca] = useState('');
  const [histStatus, setHistStatus] = useState<'todos' | 'enviado_portal' | 'falha_envio_portal'>('todos');
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

      // Pendentes (status disparado + portal pendente)
      const { count: pendentes } = await supabase
        .from('pedido_compra_sugerido')
        .select('*', { count: 'exact', head: true })
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .eq('status', 'disparado')
        .eq('status_envio_portal', 'pendente_envio_portal');

      // Enviados últimos 7d
      const seteDias = new Date(Date.now() - 7 * 86400000).toISOString();
      const { count: enviados7d } = await supabase
        .from('pedido_compra_sugerido')
        .select('*', { count: 'exact', head: true })
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .eq('status_envio_portal', 'enviado_portal')
        .gte('enviado_portal_em', seteDias);

      // Taxa sucesso 30d
      const trintaDias = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: rows30d } = await supabase
        .from('pedido_compra_sugerido')
        .select('status_envio_portal, enviado_portal_em, criado_em')
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['enviado_portal', 'falha_envio_portal'])
        .gte('criado_em', trintaDias);

      const total = (rows30d ?? []).length;
      const ok = (rows30d ?? []).filter((r) => r.status_envio_portal === 'enviado_portal').length;
      const taxa = total === 0 ? null : Math.round((ok / total) * 1000) / 10;

      void base;
      return { pendentes: pendentes ?? 0, enviados7d: enviados7d ?? 0, taxa };
    },
    refetchInterval: 30_000,
  });

  // ---------- Pendentes ----------
  const { data: pendentes, isLoading: loadingPend } = useQuery({
    queryKey: ['portal-sayerlack-pendentes', pendentesBusca],
    queryFn: async () => {
      let q = supabase
        .from('pedido_compra_sugerido')
        .select(PEDIDO_COLS)
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['pendente_envio_portal', 'enviando_portal'])
        .order('aprovado_em', { ascending: true })
        .limit(200);
      const { data, error } = await q;
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

      if (histStatus === 'todos') {
        q = q.in('status_envio_portal', ['enviado_portal', 'falha_envio_portal']);
      } else {
        q = q.eq('status_envio_portal', histStatus);
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
      const { data: rows } = await supabase
        .from('pedido_compra_sugerido')
        .select('status_envio_portal, enviado_portal_em, aprovado_em, portal_erro, criado_em')
        .eq('empresa', SAYERLACK_FILTER.empresa)
        .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
        .in('status_envio_portal', ['enviado_portal', 'falha_envio_portal'])
        .gte('criado_em', desde);

      // Por dia
      const porDia = new Map<string, { dia: string; enviado: number; falha: number }>();
      const tempos: number[] = [];
      const erros = new Map<string, { erro: string; count: number; ultimo: string }>();

      for (const r of rows ?? []) {
        const refDate = r.enviado_portal_em ?? r.criado_em;
        if (refDate) {
          const dia = new Date(refDate).toISOString().slice(0, 10);
          const cur = porDia.get(dia) ?? { dia, enviado: 0, falha: 0 };
          if (r.status_envio_portal === 'enviado_portal') cur.enviado++;
          else cur.falha++;
          porDia.set(dia, cur);
        }
        if (r.status_envio_portal === 'enviado_portal' && r.enviado_portal_em && r.aprovado_em) {
          const min = (new Date(r.enviado_portal_em).getTime() - new Date(r.aprovado_em).getTime()) / 60000;
          if (min >= 0) tempos.push(min);
        }
        if (r.status_envio_portal === 'falha_envio_portal' && r.portal_erro) {
          const key = r.portal_erro.slice(0, 100);
          const cur = erros.get(key) ?? { erro: key, count: 0, ultimo: r.criado_em };
          cur.count++;
          if (new Date(r.criado_em) > new Date(cur.ultimo)) cur.ultimo = r.criado_em;
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
        (payload: any) => {
          const fn = (payload?.new?.fornecedor_nome ?? '').toString().toUpperCase();
          if (payload?.new?.empresa === 'OBEN' && fn.includes('SAYERLACK')) {
            qc.invalidateQueries({ queryKey: ['portal-sayerlack-kpi'] });
            qc.invalidateQueries({ queryKey: ['portal-sayerlack-pendentes'] });
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
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-historico'] });
    qc.invalidateQueries({ queryKey: ['portal-sayerlack-stats'] });
  };

  // KPI colors
  const pendCor = !kpis ? 'text-muted-foreground'
    : kpis.pendentes === 0 ? 'text-muted-foreground'
    : kpis.pendentes <= 2 ? 'text-blue-600'
    : 'text-orange-600';
  const taxaCor = kpis?.taxa == null ? 'text-muted-foreground'
    : kpis.taxa >= 95 ? 'text-green-600'
    : kpis.taxa >= 80 ? 'text-yellow-600'
    : 'text-red-600';

  // CSV Export
  const handleExportCSV = async () => {
    const desde = new Date(Date.now() - 90 * 86400000).toISOString();
    const { data } = await supabase
      .from('pedido_compra_sugerido')
      .select('id, data_ciclo, num_skus, valor_total, status_envio_portal, portal_protocolo, enviado_portal_em, portal_tentativas, portal_erro')
      .eq('empresa', SAYERLACK_FILTER.empresa)
      .ilike('fornecedor_nome', SAYERLACK_FILTER.fornecedorIlike)
      .in('status_envio_portal', ['enviado_portal', 'falha_envio_portal'])
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Pendentes envio</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-4xl font-bold ${pendCor}`}>{kpis?.pendentes ?? '—'}</div>
            <div className="text-xs text-muted-foreground mt-1">pedidos aguardando envio</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Enviados últimos 7d</CardTitle></CardHeader>
          <CardContent>
            <div className="text-4xl font-bold text-green-600">{kpis?.enviados7d ?? '—'}</div>
            <div className="text-xs text-muted-foreground mt-1">pedidos finalizados</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Taxa de sucesso 30d</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-4xl font-bold ${taxaCor}`}>
              {kpis?.taxa == null ? '—' : `${String(kpis.taxa).replace('.', ',')}%`}
            </div>
            <div className="text-xs text-muted-foreground mt-1">enviados / (enviados+falhas)</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="pendentes">
        <TabsList>
          <TabsTrigger value="pendentes">Pendentes</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="estatisticas">Estatísticas</TabsTrigger>
        </TabsList>

        {/* ---------- PENDENTES ---------- */}
        <TabsContent value="pendentes" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Buscar por ID…"
              value={pendentesBusca}
              onChange={(e) => setPendentesBusca(e.target.value)}
              className="max-w-xs"
            />
          </div>
          <Card>
            <CardContent className="p-0">
              {loadingPend ? (
                <div className="p-4 space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              ) : filteredPend.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">Nenhum pedido pendente.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>ID</TableHead>
                      <TableHead>Data ciclo</TableHead>
                      <TableHead className="text-right">SKUs</TableHead>
                      <TableHead className="text-right">Valor total</TableHead>
                      <TableHead>Aprovado</TableHead>
                      <TableHead className="text-right">Tentativas</TableHead>
                      <TableHead>Próximo retry</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPend.map((p) => {
                      const t = p.portal_tentativas ?? 0;
                      const tCor = t <= 1 ? 'text-green-600' : t === 2 ? 'text-yellow-600' : 'text-red-600';
                      const retryFut = p.portal_proximo_retry_em && new Date(p.portal_proximo_retry_em) > new Date();
                      return (
                        <TableRow key={p.id}>
                          <TableCell><PortalStatusBadge status={p.status_envio_portal} /></TableCell>
                          <TableCell>
                            <Link
                              to={`/admin/reposicao/pedidos?pedido=${p.id}`}
                              className="text-primary underline-offset-2 hover:underline"
                            >
                              #{p.id}
                            </Link>
                          </TableCell>
                          <TableCell>{fmtDate(p.data_ciclo)}</TableCell>
                          <TableCell className="text-right">{p.num_skus ?? '—'}</TableCell>
                          <TableCell className="text-right">{fmtBRL(p.valor_total)}</TableCell>
                          <TableCell title={fmtDateTime(p.aprovado_em)}>{relTime(p.aprovado_em)}</TableCell>
                          <TableCell className={`text-right font-medium ${tCor}`}>{t}</TableCell>
                          <TableCell>{retryFut ? relTime(p.portal_proximo_retry_em) : '—'}</TableCell>
                          <TableCell>
                            <Button size="sm" variant="ghost" onClick={() => openDrawer(p.id)}>
                              Ver detalhes
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------- HISTÓRICO ---------- */}
        <TabsContent value="historico" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Select value={histStatus} onValueChange={(v: any) => setHistStatus(v)}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos</SelectItem>
                <SelectItem value="enviado_portal">Enviados</SelectItem>
                <SelectItem value="falha_envio_portal">Falhas</SelectItem>
              </SelectContent>
            </Select>
            <Select value={histRange} onValueChange={(v: any) => setHistRange(v)}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Últimos 7 dias</SelectItem>
                <SelectItem value="30">Últimos 30 dias</SelectItem>
                <SelectItem value="90">Últimos 90 dias</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Buscar por ID ou protocolo…"
              value={histBusca}
              onChange={(e) => setHistBusca(e.target.value)}
              className="max-w-xs"
            />
          </div>
          <Card>
            <CardContent className="p-0">
              {loadingHist ? (
                <div className="p-4 space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              ) : filteredHist.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">Sem registros no período.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>ID</TableHead>
                      <TableHead>Protocolo</TableHead>
                      <TableHead>Data ciclo</TableHead>
                      <TableHead className="text-right">SKUs</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Enviado em</TableHead>
                      <TableHead className="text-right">Tent.</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredHist.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell><PortalStatusBadge status={p.status_envio_portal} /></TableCell>
                        <TableCell>#{p.id}</TableCell>
                        <TableCell>
                          {p.portal_protocolo
                            ? p.portal_screenshot_url
                              ? <a href={p.portal_screenshot_url} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-1">
                                  {p.portal_protocolo}<ExternalLink className="h-3 w-3" />
                                </a>
                              : <span className="font-mono text-xs">{p.portal_protocolo}</span>
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>{fmtDate(p.data_ciclo)}</TableCell>
                        <TableCell className="text-right">{p.num_skus ?? '—'}</TableCell>
                        <TableCell className="text-right">{fmtBRL(p.valor_total)}</TableCell>
                        <TableCell>{fmtDateTime(p.enviado_portal_em)}</TableCell>
                        <TableCell className="text-right">{p.portal_tentativas ?? 0}</TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => openDrawer(p.id)}>
                            Ver detalhes
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------- ESTATÍSTICAS ---------- */}
        <TabsContent value="estatisticas" className="space-y-4">
          <div className="flex justify-end">
            <Button variant="outline" onClick={handleExportCSV}>
              <Download className="h-4 w-4 mr-2" />
              Exportar histórico CSV (90d)
            </Button>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Envios por dia (últimos 30 dias)</CardTitle></CardHeader>
            <CardContent style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats?.porDia ?? []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="dia" />
                  <YAxis allowDecimals={false} />
                  <RTooltip />
                  <Legend />
                  <Line type="monotone" dataKey="enviado" stroke="hsl(142, 70%, 45%)" name="Enviados" />
                  <Line type="monotone" dataKey="falha" stroke="hsl(0, 70%, 50%)" name="Falhas" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Tempo até envio (últimos 30 dias)</CardTitle></CardHeader>
            <CardContent style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats?.bins ?? []}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" />
                  <YAxis allowDecimals={false} />
                  <RTooltip />
                  <Bar dataKey="count" fill="hsl(220, 70%, 50%)" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Top falhas (últimos 30 dias)</CardTitle></CardHeader>
            <CardContent className="p-0">
              {!stats || stats.topErros.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground">Nenhuma falha no período.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Erro</TableHead>
                      <TableHead className="text-right">Ocorrências</TableHead>
                      <TableHead>Último</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.topErros.map((e) => (
                      <TableRow key={e.erro}>
                        <TableCell className="font-mono text-xs max-w-md truncate" title={e.erro}>{e.erro}</TableCell>
                        <TableCell className="text-right"><Badge variant="outline">{e.count}</Badge></TableCell>
                        <TableCell>{fmtDateTime(e.ultimo)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
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
