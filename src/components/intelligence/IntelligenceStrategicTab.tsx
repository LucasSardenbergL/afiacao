import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { kpisDesconto } from './desconto-kpis';
import { lerUltimaExecucaoAuditoria, rodapeExecucao, dataHoraExecucao, MAIORES_GAPS } from './auditoria-margem-execucao';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
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
import { mensagemDeErro } from '@/lib/erro-mensagem';

interface ScoreLinha {
  customer_user_id: string;
  /** PERCENTUAL (0–100, negativo válido). `null` = não apurada. Ver @/lib/scoring/margin. */
  gross_margin_pct: number | null;
  avg_monthly_spend_180d: number | null;
  avg_repurchase_interval: number | null;
  revenue_potential: number | null;
}

export function IntelligenceStrategicTab() {
  const queryClient = useQueryClient();
  // A ÚLTIMA execução do Algoritmo A, INTEIRA. Era `.limit(100)` sobre um log que ACRESCENTA ~508 linhas
  // por execução: os KPIs somavam 5–7% da carteira auditada (medido 2026-10-05). Reconhecimento da
  // execução, leitura estável e o que o log NÃO garante: ./auditoria-margem-execucao.ts. (E antes disso a
  // falha virava `[]` → "Margem Real R$ 0 · Gap R$ 0": a falha lança, e o estado vem de `estadoDeLeitura`.)
  const auditoriaQ = useQuery({
    queryKey: ['intel-margin-audit'],
    queryFn: lerUltimaExecucaoAuditoria,
  });
  const leituraAudit = auditoriaQ.data; // undefined = não lida · null = nenhuma execução gravada
  const estadoAudit = estadoDeLeitura(auditoriaQ);
  const auditCarregando = estadoAudit === 'carregando';

  const { data: allScores, isLoading: scoresCarregando, status: scoresStatus, fetchStatus: scoresFetch } = useQuery({
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
          .range(de, ate) as unknown as PromiseLike<{ data: ScoreLinha[] | null; error: unknown }>,
        'farmer_client_scores/intel-estrategico',
      ),
  });

  const { data: salesOrders } = useQuery({
    queryKey: ['intel-sales-orders-strategic'],
    queryFn: async () => {
      // Amostra dos 500 pedidos de VENDA mais recentes (universo canônico, ordem estável). Antes:
      // 500 linhas sem ordem nem universo — qualquer status, qualquer época.
      const { data, error } = await supabase
        .from('sales_orders')
        .select('total, discount, created_at, customer_user_id')
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(500);
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

  // margin_real/potential são null sob baixa cobertura de custo → as somas são PARCIAIS (só o conhecido);
  // nenhuma conhecida → null → "—" (nunca R$ 0). Gap = Σ margin_gap, presente em TODA linha — NÃO derivar
  // de potencial − real: os universos monetários diferem (Codex challenge).
  const agregadoAudit = leituraAudit?.agregado ?? null;
  const auditComCusto = agregadoAudit?.comMargemReal ?? 0;
  const auditTotal = agregadoAudit?.clientes ?? 0;

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
  // revenue_potential não tem produtor server-side (coluna órfã, 0/null para toda a base). Sem
  // potencial medido a concentração é 0/0 — mostrar "0,0%" fabricaria "carteira nada concentrada".
  // "—", como a Margem Bruta faz quando avgGrossMargin é null. (≠ scoresIndisponivel, que é erro
  // de leitura; aqui a leitura foi OK e o dado é que não existe.)
  const concentracaoIndisponivel = totalRevenue === 0;

  // Desconto: as duas colunas são 0 em 100% das linhas — sem desconto > 0 na amostra, "—" (ver desconto-kpis).
  const desconto = kpisDesconto(salesOrders, orderItems);

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
      // a tela promete a ÚLTIMA execução: sem invalidar, o gestor recalculava e seguia vendo a anterior
      await queryClient.invalidateQueries({ queryKey: ['intel-margin-audit'] });
      toast.success('Algoritmo A executado — auditoria atualizada');
    } catch (e) {
      toast.error('Erro: ' + (mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.'));
    } finally {
      setRunningAlgoA(false);
    }
  };

  // O gate espera TODA fonte que a tela apresenta como número. Antes ele olhava só
  // `margin_audit_log`: bastava a AUDITORIA resolver — com os scores ainda em voo — para a tela
  // renderizar inteira, e LTV/CAC/Market Share saíam em zero. Um zero de "ainda não chegou" é
  // indistinguível, na tela, de um zero medido. E "—" não serve nesta janela: "—" é o estado
  // FINAL de indisponibilidade, e carregar não é indisponível — o honesto é seguir carregando.
  if (auditCarregando || scoresCarregando) {
    return <div className="grid grid-cols-2 gap-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  }

  // Os KPIs derivados de `allScores` (LTV, CAC, Concentração, Market Share, Margem Bruta) não
  // olhavam o próprio estado de erro, então a tela renderizava INTEIRA como se estivesse tudo
  // certo, com esses números em zero produzidos por uma falha de transporte. O #1545 fazer
  // `fetchAllPages` lançar não bastou: a exceção vira `allScores === undefined` e os `|| 0`
  // fabricam de novo. Nunca zero: "—" e o motivo. `retry` é global (App.tsx: 2 + backoff);
  // aqui só o estado final.
  // `naoConsegui` cobre erro E sem-rede: offline sem cache a query fica pending/paused, SEM `isError` — e
  // os `|| 0` abaixo voltavam a fabricar LTV/CAC/Market Share em zero.
  const semLeituraScores = naoConsegui(estadoDeLeitura({ status: scoresStatus, fetchStatus: scoresFetch }));
  const scoresIndisponivel = semLeituraScores && !allScores;
  const scoresDesatualizados = semLeituraScores && !!allScores;
  const ou = (v: string) => (scoresIndisponivel ? '—' : v);

  // Mesmo par para a auditoria de margem — as duas queries falham de forma independente, e a
  // tela precisa dizer QUAL bloco não pôde ser lido (os KPIs de carteira e os de margem vêm de
  // fontes distintas). Com cache: último dado bom + aviso de stale; sem cache: "—" e o motivo.
  // `naoConsegui` cobre erro E sem-rede (offline sem cache: pending/paused, sem `isError`).
  const semLeituraAudit = naoConsegui(estadoAudit);
  const auditoriaIndisponivel = semLeituraAudit && leituraAudit === undefined;
  const auditoriaDesatualizada = semLeituraAudit && leituraAudit !== undefined;
  const semAuditoria = leituraAudit === null;
  // o escritor grava UMA linha por cliente: cliente repetido = execução mal reconhecida → não somar
  const auditoriaInvalida = (agregadoAudit?.duplicados ?? 0) > 0;
  const semNumeroAudit = auditoriaIndisponivel || semAuditoria || auditoriaInvalida;
  const ouAudit = (v: string) => (semNumeroAudit ? '—' : v);
  const brl = (v: number | null) => (v == null ? '—' : `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`);
  const legendaAudit = auditoriaIndisponivel
    ? 'auditoria indisponível'
    : semAuditoria
      ? 'nenhuma execução gravada'
      : auditoriaInvalida
        ? 'execução inválida — clientes duplicados'
        : `parcial — ${auditComCusto}/${auditTotal} clientes c/ custo`;

  return (
    <div className="space-y-4">
      {scoresIndisponivel && (
        <div role="alert" className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-xs text-status-error">
          Indicadores de carteira indisponíveis — a base de scores não pôde ser lida. LTV, CAC,
          Concentração, Market Share e Margem Bruta ficam em “—”; nenhum deles foi estimado.
        </div>
      )}
      {scoresDesatualizados && (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning">
          Exibindo a última leitura bem-sucedida da base de scores — a atualização mais recente
          falhou. Os indicadores de carteira podem estar desatualizados.
        </div>
      )}
      {auditoriaIndisponivel && (
        <div role="alert" className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-xs text-status-error">
          Auditoria de margem indisponível — o log do Algoritmo A não pôde ser lido. Margem Real,
          Potencial, Gap e Margem Global ficam em “—”; nenhum valor foi somado.
        </div>
      )}
      {auditoriaDesatualizada && (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning">
          Exibindo a última leitura bem-sucedida da auditoria de margem — a atualização mais
          recente falhou. Os valores do Algoritmo A podem estar desatualizados.
        </div>
      )}
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
          <KpiCard title="Margem Real" value={ouAudit(brl(agregadoAudit?.margemReal ?? null))} icon={DollarSign} subtitle={legendaAudit} />
          <KpiCard title="Margem Potencial" value={ouAudit(brl(agregadoAudit?.margemPotencial ?? null))} icon={TrendingUp} subtitle={legendaAudit} />
          <KpiCard title="Gap de Margem" value={ouAudit(brl(agregadoAudit?.gap ?? null))} icon={TrendingDown} subtitle={semNumeroAudit ? legendaAudit : 'vazamento de preço (todos os clientes auditados)'} />
          {/* "0" afirmaria que a auditoria rodou e não achou ninguém — a mesma troca de "não consegui
              ler" por "não existe" que os KPIs monetários ao lado fazem em R$. */}
          <KpiCard title="Clientes auditados" value={ouAudit(String(auditTotal))} icon={Eye} />
        </div>
        {leituraAudit && !auditoriaInvalida && (
          <p className="mt-2 text-[11px] text-muted-foreground" data-testid="rodape-execucao">{rodapeExecucao(leituraAudit)}</p>
        )}
      </div>

      {/* Strategic KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="LTV Projetado (3a)" value={ou(`R$ ${ltvEstimate.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`)} icon={BarChart3} subtitle="Estimativa média" />
        <KpiCard title="CAC Estimado" value={ou(`R$ ${cacEstimate.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`)} icon={DollarSign} subtitle="Custo aquisição cliente" />
        <KpiCard title="Concentração Top 20%" value={scoresIndisponivel || concentracaoIndisponivel ? '—' : `${concentrationPct.toFixed(1)}%`} icon={PieChart} subtitle={scoresIndisponivel ? 'base indisponível' : concentracaoIndisponivel ? 'potencial não medido' : 'da receita total'} />
        <KpiCard
          title="Margem Bruta Média"
          value={scoresIndisponivel || avgGrossMargin == null ? '—' : `${avgGrossMargin.toFixed(1)}%`}
          icon={Percent}
          subtitle={scoresIndisponivel ? 'base indisponível' : legendaCobertura(coberturaGrossMargin)}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          title="Elasticidade de Preço"
          value={desconto.elasticidade === null ? '—' : `${desconto.elasticidade.toFixed(1)}%`}
          icon={TrendingUp}
          subtitle={desconto.elasticidade === null ? 'desconto não registrado nos itens' : 'Δ qty c/ desconto'}
        />
        <KpiCard
          title="Sensibilidade a Desconto"
          value={desconto.sensibilidade === null ? '—' : `${desconto.sensibilidade.toFixed(1)}%`}
          icon={Percent}
          subtitle={
            desconto.sensibilidade !== null
              ? `${desconto.pedidosComDesconto} de ${desconto.pedidos} pedidos recentes`
              : salesOrders ? 'desconto não registrado no pedido' : 'pedidos indisponíveis'
          }
        />
        <KpiCard title="Market Share Est." value={ou(`${marketSharePct.toFixed(1)}%`)} icon={Target} subtitle={scoresIndisponivel ? 'base indisponível' : `${uniqueCustomers} de ~${estimatedMarket} clientes`} />
        <KpiCard title="Margem Global" value={ouAudit(brl(agregadoAudit?.margemReal ?? null))} icon={DollarSign} subtitle={legendaAudit} />
      </div>

      {/* Margin Audit Table */}
      {leituraAudit && !auditoriaInvalida && leituraAudit.agregado.maioresGaps.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Maiores gaps da última execução</CardTitle>
            <CardDescription className="text-xs">
              Até {MAIORES_GAPS} clientes por gap, entre {leituraAudit.agregado.clientes} auditados · execução de{' '}
              {dataHoraExecucao(leituraAudit.execucao.carimbo)}
            </CardDescription>
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
                    <th className="text-right py-2 font-medium text-muted-foreground">Gap %</th>
                  </tr>
                </thead>
                <tbody>
                  {leituraAudit.agregado.maioresGaps.map(row => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                      <td className="py-2 font-mono">{clientNameMap[row.customer_user_id] ?? `${row.customer_user_id.slice(0, 8)}...`}</td>
                      <td className="text-center py-2">{row.margin_real == null ? '—' : `R$ ${Number(row.margin_real).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}</td>
                      <td className="text-center py-2">{row.margin_potential == null ? '—' : `R$ ${Number(row.margin_potential).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}`}</td>
                      <td className="text-center py-2 text-destructive">R$ {Number(row.margin_gap).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}</td>
                      <td className="text-right py-2">{row.gap_pct == null ? '—' : `${Number(row.gap_pct).toFixed(1)}%`}</td>
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
