import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { supabase } from '@/integrations/supabase/client';
import { getResumoFinanceiro, getAgingReceber, getDRE, getTopInadimplentes, type FinResumo, type AgingData, type FinDRE } from '@/services/financeiroService';
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import { RegimeToggle } from '@/components/financeiro/RegimeToggle';
import {
  Building2, TrendingUp, TrendingDown, AlertTriangle, Wallet,
  ShieldCheck, Shield, BarChart3, Target, Clock, Eye, Lock,
  CheckCircle2, Info, XCircle
} from 'lucide-react';
import { CockpitDrillDown, type DrillDownType } from '@/components/financeiro/CockpitDrillDown';
import { PeriodOverrideHistory } from '@/components/financeiro/PeriodOverrideHistory';
import { logger } from '@/lib/logger';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};

// ═══════════════ TRANSPARENCY BADGE ═══════════════
function TransparencyBadge({ conf }: { conf: any | null }) {
  if (!conf) return <Badge variant="outline" className="text-[9px]">Sem dados de confiabilidade</Badge>;

  const pctMap = conf.pct_valor_mapeado || 0;
  const pctConc = conf.pct_mov_conciliado || 0;
  const fech = conf.fechamento_status || 'sem_fechamento';
  const catHeur = conf.dre_categorias_heuristica || 0;

  const score = Math.round((pctMap * 0.4) + (pctConc * 0.3) + (fech === 'fechado' ? 30 : 0));
  const color = score >= 70 ? 'text-status-success' : score >= 40 ? 'text-status-warning' : 'text-status-error';
  const bg = score >= 70 ? 'bg-status-success-bg border-status-success/20' : score >= 40 ? 'bg-status-warning-bg border-status-warning/20' : 'bg-status-error-bg border-status-error/20';

  return (
    <div className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs ${bg}`}>
      <span className={`font-semibold tabular-nums ${color}`}>{score}%</span>
      <span className="text-muted-foreground">confiável</span>
      <span className="text-muted-foreground">·</span>
      <span className="tabular-nums">{pctMap.toFixed(0)}% mapeado</span>
      <span className="text-muted-foreground">·</span>
      <span className="tabular-nums">{pctConc.toFixed(0)}% conciliado</span>
      {catHeur > 0 && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-status-warning">{catHeur} cat. heurísticas</span>
        </>
      )}
      <span className="text-muted-foreground">·</span>
      <FechamentoIcon status={fech} />
    </div>
  );
}

function FechamentoIcon({ status }: { status: string }) {
  switch (status) {
    case 'fechado': return <span className="flex items-center gap-0.5 text-status-success"><Lock className="w-3 h-3" /> Fechado</span>;
    case 'em_revisao': return <span className="flex items-center gap-0.5 text-status-warning"><Eye className="w-3 h-3" /> Revisão</span>;
    case 'reaberto': return <span className="flex items-center gap-0.5 text-status-error"><AlertTriangle className="w-3 h-3" /> Reaberto</span>;
    default: return <span className="flex items-center gap-0.5 text-muted-foreground"><Clock className="w-3 h-3" /> Aberto</span>;
  }
}

// ═══════════════ MAIN COMPONENT ═══════════════

const FinanceiroCockpit = () => {
  const [loading, setLoading] = useState(true);
  const [resumo, setResumo] = useState<Record<string, FinResumo>>({});
  const [aging, setAging] = useState<AgingData | null>(null);
  const [dre, setDre] = useState<FinDRE[]>([]);
  const [inadimplentes, setInadimplentes] = useState<any[]>([]);
  const [projecao13, setProjecao13] = useState<any[]>([]);
  const [confiabilidade, setConfiabilidade] = useState<any[]>([]);
  const [drillDown, setDrillDown] = useState<DrillDownType>(null);

  const { regime } = useFinanceiroRegime();
  const ano = new Date().getFullYear();
  const mes = new Date().getMonth() + 1;

  useEffect(() => { loadAll(); }, [regime]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [res, ag, dr, inad] = await Promise.all([
        getResumoFinanceiro(['oben', 'colacor', 'colacor_sc']),
        getAgingReceber('all'),
        Promise.all(['oben', 'colacor', 'colacor_sc'].map(co => getDRE(co as Company, ano, undefined, regime))).then(r => r.flat()),
        getTopInadimplentes('all', 5),
      ]);
      setResumo(res);
      setAging(ag);
      setDre(dr);
      setInadimplentes(inad);

      // 13-week projection via RPC
      try {
        const { data: proj } = await supabase.rpc('fin_projecao_13_semanas' as any, {}) as any;
        setProjecao13(proj || []);
      } catch (e) {
        // RPC pode não existir ainda — registra para visibilidade em vez de falhar silencioso
        logger.warn('RPC fin_projecao_13_semanas indisponível', {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // Confiabilidade for current month per company
      const confResults: any[] = [];
      for (const co of ['oben', 'colacor', 'colacor_sc']) {
        try {
          const { data: conf } = await supabase
            .from('fin_confiabilidade' as any)
            .select('*')
            .eq('company', co)
            .eq('ano', ano)
            .eq('mes', mes)
            .maybeSingle();
          if (conf) confResults.push(conf);
        } catch (e) {
          logger.warn('Tabela fin_confiabilidade indisponível', {
            company: co,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      setConfiabilidade(confResults);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Computed
  const totalCC = Object.values(resumo).reduce((s, r) => s + r.saldo_total_cc, 0);
  const totalCR = Object.values(resumo).reduce((s, r) => s + r.total_a_receber, 0);
  const totalCP = Object.values(resumo).reduce((s, r) => s + r.total_a_pagar, 0);
  const totalVencidoCR = Object.values(resumo).reduce((s, r) => s + r.total_vencido_receber, 0);
  const ncg = totalCR - totalCP; // Necessidade de capital de giro
  const pctInadimplencia = totalCR > 0 ? (totalVencidoCR / totalCR) * 100 : 0;

  // DRE do mês mais recente
  const dreUltimo = new Map<string, FinDRE>();
  for (const d of dre) {
    const key = d.company;
    if (!dreUltimo.has(key) || d.mes > (dreUltimo.get(key)?.mes || 0)) {
      dreUltimo.set(key, d);
    }
  }
  const dreConsolidado = Array.from(dreUltimo.values());
  const totalReceita = dreConsolidado.reduce((s, d) => s + d.receita_liquida, 0);
  const totalLucroBruto = dreConsolidado.reduce((s, d) => s + d.lucro_bruto, 0);
  const totalResultadoOp = dreConsolidado.reduce((s, d) => s + d.resultado_operacional, 0);
  const margemBruta = totalReceita > 0 ? (totalLucroBruto / totalReceita) * 100 : 0;
  const margemOp = totalReceita > 0 ? (totalResultadoOp / totalReceita) * 100 : 0;

  // Risco de liquidez
  const riscoLiquidez = totalCP > 0 && totalCC > 0
    ? totalCC / totalCP
    : 0;
  const riscoLabel = riscoLiquidez >= 1 ? 'Baixo' : riscoLiquidez >= 0.5 ? 'Médio' : 'Alto';
  const riscoColor = riscoLiquidez >= 1 ? 'text-status-success' : riscoLiquidez >= 0.5 ? 'text-status-warning' : 'text-status-error';

  // Concentração (do aging)
  const totalAgingCR = aging
    ? aging.a_vencer_valor + aging.vencido_1_30_valor + aging.vencido_31_60_valor + aging.vencido_61_90_valor + aging.vencido_90_plus_valor
    : 0;
  const pctCritico = totalAgingCR > 0
    ? ((aging?.vencido_61_90_valor || 0) + (aging?.vencido_90_plus_valor || 0)) / totalAgingCR * 100
    : 0;

  if (loading) {
    return (
      <div className="space-y-4 pb-24">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-3 gap-3">{[1,2,3].map(i => <Skeleton key={i} className="h-28" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      {/* Header — display serif Newsreader em h1 + atmosphere gradient sutil + noise */}
      <div className="relative bg-cockpit-hero noise rounded-lg border border-border px-6 py-8 flex items-center justify-between flex-wrap gap-3 overflow-hidden">
        <div className="relative">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium mb-1.5">
            Financeiro · Cockpit
          </p>
          <h1 className="font-display" style={{ fontSize: '2.25rem', fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
            Visão consolidada
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 tabular-nums">
            {new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
          </p>
        </div>
        {/* Global transparency + regime toggle */}
        <div className="relative flex flex-col items-end gap-3">
          <RegimeToggle />
          {confiabilidade.length > 0 && (
            <div className="flex flex-col items-end gap-1">
              {confiabilidade.map(c => (
                <div key={c.company} className="flex items-center gap-2">
                  <span className="text-xs font-medium">{COMPANIES[c.company as Company]?.shortName}</span>
                  <TransparencyBadge conf={c} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Row 1: Big 3 — staggered reveal pra page load orquestrado */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 stagger-children">
        <CockpitCard
          title="Caixa Disponível"
          value={fmtCompact(totalCC)}
          positive={totalCC > 0}
          icon={Wallet}
          detail={`Risco de liquidez: ${riscoLabel} (${(riscoLiquidez * 100).toFixed(0)}%)`}
          detailColor={riscoColor}
          badge="Saldo bancário real"
          onClick={() => setDrillDown('caixa')}
        />
        <CockpitCard
          title="Caixa Projetado 30d"
          value={fmtCompact(totalCC + totalCR - totalCP)}
          positive={totalCC + totalCR - totalCP > 0}
          icon={Target}
          detail={`+ ${fmtCompact(totalCR)} entradas / - ${fmtCompact(totalCP)} saídas`}
          badge="CR+CC-CP abertos"
          onClick={() => setDrillDown('cr_aberto')}
        />
        <CockpitCard
          title="Necessidade de CG"
          value={fmtCompact(ncg)}
          positive={ncg >= 0}
          icon={ncg >= 0 ? TrendingUp : TrendingDown}
          detail={ncg >= 0 ? 'CR cobre CP — posição confortável' : 'CP excede CR — atenção ao caixa'}
          detailColor={ncg >= 0 ? 'text-status-success' : 'text-status-error'}
          badge="CR - CP"
          onClick={() => setDrillDown('cr_aberto')}
        />
      </div>

      {/* Row 2: Margens + Inadimplência + Risco — também staggered */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 stagger-children">
        <MiniCard label="Margem Bruta" value={`${margemBruta.toFixed(1)}%`}
          color={margemBruta >= 30 ? 'text-status-success' : 'text-status-warning'} />
        <MiniCard label="Margem Operacional" value={`${margemOp.toFixed(1)}%`}
          color={margemOp >= 10 ? 'text-status-success' : margemOp >= 0 ? 'text-status-warning' : 'text-status-error'} />
        <MiniCard label="Inadimplência" value={`${pctInadimplencia.toFixed(1)}%`}
          color={pctInadimplencia <= 10 ? 'text-status-success' : pctInadimplencia <= 25 ? 'text-status-warning' : 'text-status-error'}
          subtitle={fmtCompact(totalVencidoCR)}
          onClick={() => setDrillDown('inadimplencia')} />
        <MiniCard label="Aging Crítico (+60d)" value={`${pctCritico.toFixed(1)}%`}
          color={pctCritico <= 5 ? 'text-status-success' : pctCritico <= 15 ? 'text-status-warning' : 'text-status-error'}
          subtitle={fmtCompact((aging?.vencido_61_90_valor || 0) + (aging?.vencido_90_plus_valor || 0))}
          onClick={() => setDrillDown('aging_critico')} />
      </div>

      {/* Row 3: Resultado por empresa */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Resultado por Empresa (último mês)
            <Badge variant="outline" className="text-[10px]">Regime de Caixa</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dreConsolidado.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem DRE calculado. Recalcule na aba DRE.</p>
          ) : (
            <div className="space-y-3">
              {dreConsolidado.map(d => {
                const mg = d.receita_liquida > 0 ? (d.lucro_bruto / d.receita_liquida) * 100 : 0;
                const mo = d.receita_liquida > 0 ? (d.resultado_operacional / d.receita_liquida) * 100 : 0;
                const conf = confiabilidade.find(c => c.company === d.company);
                return (
                  <div key={d.company} className="flex items-center justify-between p-3 rounded-lg bg-muted/40">
                    <div className="flex items-center gap-3">
                      <Badge variant="outline">{COMPANIES[d.company as Company]?.shortName}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][d.mes - 1]}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">Receita</p>
                        <p className="font-medium">{fmtCompact(d.receita_liquida)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">MB</p>
                        <p className={`font-bold ${mg >= 30 ? 'text-status-success' : 'text-status-warning'}`}>{mg.toFixed(1)}%</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">Resultado</p>
                        <p className={`font-bold ${d.resultado_liquido >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                          {fmtCompact(d.resultado_liquido)}
                        </p>
                      </div>
                      {conf && (
                        <div className="text-right">
                          <p className="text-[10px] text-muted-foreground">Mapeado</p>
                          <p className={`text-xs font-medium ${(conf.pct_valor_mapeado || 0) >= 80 ? 'text-status-success' : 'text-status-warning'}`}>
                            {(conf.pct_valor_mapeado || 0).toFixed(0)}%
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Row 4: Projeção 13 semanas */}
      {projecao13.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Target className="w-4 h-4" />
              Projeção de Caixa — 13 Semanas
              <Badge variant="outline" className="text-[10px]">Consolidado · Baseado em CR/CP abertos</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[90px]">Semana</TableHead>
                    <TableHead className="text-right">Entradas</TableHead>
                    <TableHead className="text-right">Saídas</TableHead>
                    <TableHead className="text-right">Fluxo</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projecao13.map((w: any, i: number) => (
                    <TableRow key={i} className={w.saldo_projetado < 0 ? 'bg-status-error-bg' : ''}>
                      <TableCell className="text-xs">{w.semana_label}</TableCell>
                      <TableCell className="text-right text-sm text-status-success">{fmtCompact(w.entradas_previstas)}</TableCell>
                      <TableCell className="text-right text-sm text-status-error">{fmtCompact(w.saidas_previstas)}</TableCell>
                      <TableCell className={`text-right text-sm font-medium ${w.fluxo_liquido >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                        {fmtCompact(w.fluxo_liquido)}
                      </TableCell>
                      <TableCell className={`text-right text-sm font-bold ${w.saldo_projetado >= 0 ? 'text-status-info' : 'text-status-error'}`}>
                        {fmtCompact(w.saldo_projetado)}
                        {w.saldo_projetado < 0 && <AlertTriangle className="inline w-3 h-3 ml-1 text-status-error" />}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {projecao13.some((w: any) => w.saldo_projetado < 0) && (
              <div className="mt-3 p-3 rounded-lg bg-status-error-bg border border-status-error/20 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-status-error mt-0.5 shrink-0" />
                <p className="text-sm text-status-error-fg">
                  Projeção indica saldo negativo em {projecao13.filter((w: any) => w.saldo_projetado < 0).length} semana(s).
                  Ação necessária antes de {projecao13.find((w: any) => w.saldo_projetado < 0)?.semana_label}.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Row 5: Top inadimplentes */}
      {inadimplentes.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-status-error" />
              Inadimplência Crítica — Top 5
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {inadimplentes.map((i, idx) => (
                <div key={idx} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div>
                    <p className="font-medium text-sm">{i.nome || (i.cnpj ? `CNPJ: ${i.cnpj}` : 'Cliente não identificado')}</p>
                    <p className="text-xs text-muted-foreground">{i.qtd_titulos} título(s)</p>
                  </div>
                  <span className="font-bold text-status-error">{fmt(i.total_vencido)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Period override history */}
      <PeriodOverrideHistory />

      {/* Data basis footer */}
      <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg space-y-1">
        <p className="font-medium flex items-center gap-1"><Info className="w-3 h-3" /> Base dos números</p>
        <p>Saldo bancário: consulta direta Omie (ResumirContaCorrente). CR/CP: títulos sincronizados (últimos 6 meses). DRE: regime de caixa (pagamento/recebimento efetivo). Projeção 13 semanas: baseada em vencimentos de títulos abertos.</p>
        <p>Para números de controller, verifique: % mapeado ≥ 80%, conciliação ≥ 70%, mês fechado.</p>
      </div>

      <CockpitDrillDown type={drillDown} onClose={() => setDrillDown(null)} />
    </div>
  );
};

// ═══════════════ SUB-COMPONENTS ═══════════════

function CockpitCard({ title, value, positive, icon: Icon, detail, detailColor, badge, onClick }: {
  title: string; value: string; positive: boolean; icon: any;
  detail?: string; detailColor?: string; badge?: string; onClick?: () => void;
}) {
  return (
    <Card className={onClick ? 'cursor-pointer hover:bg-muted/30 transition-colors' : ''} onClick={onClick}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{title}</p>
            <p className={`kpi-value text-3xl mt-2 ${positive ? 'text-status-success' : 'text-status-error'}`}>{value}</p>
            {detail && (
              <p className={`text-xs mt-2 ${detailColor || 'text-muted-foreground'}`}>{detail}</p>
            )}
            {badge && (
              <Badge variant="outline" className="mt-2 text-[9px]">{badge}</Badge>
            )}
          </div>
          <div className={`p-2.5 rounded-md ${positive ? 'bg-status-success-bg' : 'bg-status-error-bg'}`}>
            <Icon className={`w-4 h-4 ${positive ? 'text-status-success' : 'text-status-error'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MiniCard({ label, value, color, subtitle, onClick }: {
  label: string; value: string; color: string; subtitle?: string; onClick?: () => void;
}) {
  return (
    <div className={`p-3 rounded-md border bg-card text-center ${onClick ? 'cursor-pointer hover:bg-muted/30 transition-colors' : ''}`} onClick={onClick}>
      <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
      <p className={`kpi-value text-xl mt-1 ${color}`}>{value}</p>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">{subtitle}</p>}
    </div>
  );
}

export default FinanceiroCockpit;
