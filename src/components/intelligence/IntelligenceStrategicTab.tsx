import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  DollarSign, TrendingUp, TrendingDown, Target, Eye, Percent,
  BarChart3, PieChart, ShieldCheck, RefreshCw
} from 'lucide-react';
import { toast } from 'sonner';
import { mediaMargensConhecidas, coberturaMargem, legendaCobertura } from '@/lib/scoring/margin';
import { fetchAllPages } from '@/lib/postgrest';
import { KpiCard } from './KpiCard';

interface ScoreLinha {
  customer_user_id: string;
  /** PERCENTUAL (0–100, negativo válido). `null` = não apurada. Ver @/lib/scoring/margin. */
  gross_margin_pct: number | null;
  avg_monthly_spend_180d: number | null;
  avg_repurchase_interval: number | null;
  revenue_potential: number | null;
}

export function IntelligenceStrategicTab() {
  const { data: marginAudit, isLoading } = useQuery({
    queryKey: ['intel-margin-audit'],
    queryFn: async () => {
      const { data, error } = await supabase.from('margin_audit_log').select('*').order('calculated_at', { ascending: false }).limit(100);
      if (error) { console.error(error); return []; }
      return data || [];
    },
  });

  const { data: allScores } = useQuery({
    queryKey: ['intel-strategic-scores'],
    // Base COMPLETA, paginada. Era `.limit(500)` de 6.632 e SEM `.order()` — o Postgres não
    // garante ordem sem ORDER BY, então as 500 eram um recorte não determinístico: dois
    // carregamentos podiam produzir KPIs diferentes da mesma base, sem nada na tela indicando.
    queryFn: () =>
      fetchAllPages<ScoreLinha>((de, ate) =>
        supabase
          .from('farmer_client_scores')
          .select('customer_user_id, gross_margin_pct, avg_monthly_spend_180d, avg_repurchase_interval, revenue_potential')
          .order('customer_user_id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ScoreLinha[] | null }>,
      ),
  });

  const { data: salesOrders } = useQuery({
    queryKey: ['intel-sales-orders-strategic'],
    queryFn: async () => {
      const { data, error } = await supabase.from('sales_orders').select('total, discount, created_at, customer_user_id').limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: orderItems } = useQuery({
    queryKey: ['intel-order-items-strategic'],
    queryFn: async () => {
      const { data, error } = await supabase.from('order_items').select('unit_price, discount, quantity, product_id').limit(1000);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: clientProfiles } = useQuery({
    queryKey: ['intel-strategic-client-profiles'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('user_id, name').eq('is_employee', false);
      if (error) throw error;
      return data || [];
    },
  });

  const clientNameMap = (clientProfiles || []).reduce((acc, p) => {
    if (p.user_id) acc[p.user_id] = p.name || '';
    return acc;
  }, {} as Record<string, string>);

  // margin_real/potential agora são null sob baixa cobertura de custo → somas são PARCIAIS (covered-only).
  const totalMarginReal = marginAudit?.reduce((a, r) => a + Number(r.margin_real || 0), 0) || 0;
  const totalMarginPotential = marginAudit?.reduce((a, r) => a + Number(r.margin_potential || 0), 0) || 0;
  // Gap headline = Σ margin_gap (cost-free, presente em TODA linha). NÃO derivar de potential−real:
  // linhas de baixa cobertura têm margens null→0 mas margin_gap real, e o gap sumiria (Codex challenge).
  const totalGap = marginAudit?.reduce((a, r) => a + Number(r.margin_gap || 0), 0) || 0;
  // Quantos clientes têm margem absoluta computável (custo real ≥85% da receita) — disclosure de que
  // Margem Real/Potencial/Global são PARCIAIS sob baixa cobertura (Codex #8: não esconder o parcial).
  const auditComCusto = marginAudit?.filter(r => r.margin_real != null).length || 0;
  const auditTotal = marginAudit?.length || 0;

  const avgSpend = allScores?.length
    ? allScores.reduce((a, c) => a + Number(c.avg_monthly_spend_180d || 0), 0) / allScores.length
    : 0;
  const ltvEstimate = avgSpend * 12 * 3;

  const totalClients = allScores?.length || 1;
  const avgCostPerHour = 50;
  const totalCallHours = allScores?.reduce((a, c) => a + Number(c.avg_repurchase_interval || 0) * 0.1, 0) || 0;
  const cacEstimate = totalClients > 0 ? (totalCallHours * avgCostPerHour) / totalClients : 0;

  const sortedByRevenue = [...(allScores || [])].sort((a, b) => Number(b.revenue_potential || 0) - Number(a.revenue_potential || 0));
  const top20Count = Math.ceil(sortedByRevenue.length * 0.2);
  const top20Revenue = sortedByRevenue.slice(0, top20Count).reduce((a, c) => a + Number(c.revenue_potential || 0), 0);
  const totalRevenue = sortedByRevenue.reduce((a, c) => a + Number(c.revenue_potential || 0), 0);
  const concentrationPct = totalRevenue > 0 ? (top20Revenue / totalRevenue * 100) : 0;

  const discountedItems = orderItems?.filter(i => Number(i.discount || 0) > 0) || [];
  const avgDiscountQty = discountedItems.length > 0
    ? discountedItems.reduce((a, i) => a + Number(i.quantity), 0) / discountedItems.length : 0;
  const nonDiscountedItems = orderItems?.filter(i => Number(i.discount || 0) === 0) || [];
  const avgNonDiscountQty = nonDiscountedItems.length > 0
    ? nonDiscountedItems.reduce((a, i) => a + Number(i.quantity), 0) / nonDiscountedItems.length : 0;
  const priceElasticity = avgNonDiscountQty > 0 ? ((avgDiscountQty - avgNonDiscountQty) / avgNonDiscountQty * 100) : 0;

  const ordersWithDiscount = salesOrders?.filter(o => Number(o.discount || 0) > 0).length || 0;
  const discountSensitivity = salesOrders?.length ? (ordersWithDiscount / salesOrders.length * 100) : 0;

  const uniqueCustomers = new Set(allScores?.map(c => c.customer_user_id)).size;
  const estimatedMarket = Math.max(uniqueCustomers * 3, 100);
  const marketSharePct = (uniqueCustomers / estimatedMarket * 100);

  // Só as margens conhecidas entram na média (numerador E denominador). Com `|| 0`, cliente sem
  // margem apurada entrava como 0 — e como esse é o caso da maioria da base desde o cálculo
  // server-side, o KPI estratégico viraria uma medida de cobertura de custo disfarçada de margem.
  const avgGrossMargin = mediaMargensConhecidas((allScores ?? []).map(c => c.gross_margin_pct));
  const coberturaGrossMargin = coberturaMargem((allScores ?? []).map(c => c.gross_margin_pct));

  const [runningAlgoA, setRunningAlgoA] = useState(false);
  const runAlgoA = async () => {
    setRunningAlgoA(true);
    try {
      const { error } = await supabase.functions.invoke('algorithm-a-audit');
      if (error) throw error;
      toast.success('Algoritmo A executado com sucesso');
    } catch (e) {
      toast.error('Erro: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRunningAlgoA(false);
    }
  };

  if (isLoading) {
    return <div className="grid grid-cols-2 gap-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Algoritmo A – Margin Gap */}
      <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-status-warning" />
            <span className="text-xs font-semibold text-status-warning uppercase tracking-wider">Algoritmo A — Auditoria de Margem (Confidencial)</span>
          </div>
          <Button size="sm" variant="outline" onClick={runAlgoA} disabled={runningAlgoA} className="h-7 text-xs">
            <RefreshCw className={`w-3 h-3 mr-1 ${runningAlgoA ? 'animate-spin' : ''}`} />
            Recalcular
          </Button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard title="Margem Real" value={`R$ ${totalMarginReal.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={DollarSign} subtitle={`parcial — ${auditComCusto}/${auditTotal} clientes c/ custo`} />
          <KpiCard title="Margem Potencial" value={`R$ ${totalMarginPotential.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={TrendingUp} subtitle={`parcial — ${auditComCusto}/${auditTotal} clientes c/ custo`} />
          <KpiCard title="Gap de Margem" value={`R$ ${totalGap.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={TrendingDown} subtitle="vazamento de preço (todas as linhas)" />
          <KpiCard title="Registros" value={String(marginAudit?.length || 0)} icon={Eye} />
        </div>
      </div>

      {/* Strategic KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="LTV Projetado (3a)" value={`R$ ${ltvEstimate.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={BarChart3} subtitle="Estimativa média" />
        <KpiCard title="CAC Estimado" value={`R$ ${cacEstimate.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={DollarSign} subtitle="Custo aquisição cliente" />
        <KpiCard title="Concentração Top 20%" value={`${concentrationPct.toFixed(1)}%`} icon={PieChart} subtitle="da receita total" />
        <KpiCard
          title="Margem Bruta Média"
          value={avgGrossMargin == null ? '—' : `${avgGrossMargin.toFixed(1)}%`}
          icon={Percent}
          subtitle={legendaCobertura(coberturaGrossMargin)}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Elasticidade de Preço" value={`${priceElasticity.toFixed(1)}%`} icon={TrendingUp} subtitle="Δ qty c/ desconto" />
        <KpiCard title="Sensibilidade a Desconto" value={`${discountSensitivity.toFixed(1)}%`} icon={Percent} subtitle={`${ordersWithDiscount} de ${salesOrders?.length || 0} pedidos`} />
        <KpiCard title="Market Share Est." value={`${marketSharePct.toFixed(1)}%`} icon={Target} subtitle={`${uniqueCustomers} de ~${estimatedMarket} clientes`} />
        <KpiCard title="Margem Global" value={`R$ ${totalMarginReal.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`} icon={DollarSign} subtitle={`parcial — ${auditComCusto}/${auditTotal} c/ custo`} />
      </div>

      {/* Margin Audit Table */}
      {marginAudit && marginAudit.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Log de Auditoria de Margem</CardTitle>
            <CardDescription className="text-xs">Últimos registros do Algoritmo A</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium text-muted-foreground">Cliente</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">M. Real</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">M. Potencial</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">Gap</th>
                    <th className="text-center py-2 font-medium text-muted-foreground">Gap %</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {marginAudit.slice(0, 20).map(row => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                      <td className="py-2 font-mono">{clientNameMap[row.customer_user_id] ?? `${row.customer_user_id.slice(0, 8)}...`}</td>
                      <td className="text-center py-2">{row.margin_real == null ? '—' : `R$ ${Number(row.margin_real).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}</td>
                      <td className="text-center py-2">{row.margin_potential == null ? '—' : `R$ ${Number(row.margin_potential).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}</td>
                      <td className="text-center py-2 text-destructive">R$ {Number(row.margin_gap).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-center py-2">{row.gap_pct == null ? '—' : `${Number(row.gap_pct).toFixed(1)}%`}</td>
                      <td className="text-right py-2 text-muted-foreground">{new Date(row.calculated_at).toLocaleDateString('pt-BR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
