// Hook de dados/estado do Cockpit financeiro: uma query react-query por bloco
// (resumo/aging/DRE/inadimplentes/projeção 13s/Fleuriet/confiabilidade) e
// todos os derivados consolidados.
import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Company } from '@/contexts/CompanyContext';
import { supabase } from '@/integrations/supabase/client';
import { getResumoFinanceiro, getAgingReceber, getDRE, getTopInadimplentes, type FinDRE } from '@/services/financeiroService';
import { getProjecaoSnapshotsCockpit, getBalancoInputs, getNcgNaJanela, type BalancoInputRow } from '@/services/financeiroV2Service';
import { caixaDoGrupo, consolidarCockpit, type CockpitConsolidado } from '@/lib/financeiro/cockpit-consolida-helpers';
import { consolidarTitulos } from '@/lib/financeiro/resumo-titulos';
import { classificarFleurietEmpresa, type ClassificacaoFleurietEmpresa } from '@/lib/financeiro/fleuriet-helpers';
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import { logger } from '@/lib/logger';
import type { DrillDownType } from '@/components/financeiro/CockpitDrillDown';
import type { FinConfiabilidadeRow } from './types';
import { mensagemDeErro } from '@/lib/erro-mensagem';

const EMPRESAS_COCKPIT: Company[] = ['oben', 'colacor', 'colacor_sc'];
// Default = indisponível/parcial (Codex P1): em falha de carga, NCG não pode aparecer como R$0 "saudável".
const COCKPIT_VAZIO: CockpitConsolidado = {
  projecao13: [], ncg_total: 0, ncg_por_empresa: [], ncg_parcial: true,
  saldo_tesouraria_total: 0, saldo_tesouraria_parcial: true,
  empresas_presentes: [], empresas_ausentes: [...EMPRESAS_COCKPIT], empresas_stale: [],
  parcial: true, data_referencia: null, snapshot_at_mais_antigo: null,
  caixa_inicial_projecao: null, caixa_inicial_por_empresa: [], caixa_inicial_parcial: true,
};

// Receita líquida do mês mais recente por empresa (banda de materialidade do Fleuriet).
// getDRE é chamado com o ano corrente fixo → comparar por mes basta (mesmo padrão de dreUltimo).
function receitaLiquidaMensal(dre: FinDRE[], company: string): number | null {
  let melhor: FinDRE | null = null;
  for (const d of dre) {
    if (d.company !== company) continue;
    if (!melhor || d.mes > melhor.mes) melhor = d;
  }
  return melhor ? melhor.receita_liquida : null;
}

// Prefixo de TODAS as queries do cockpit — `recarregar` invalida por ele.
const QK = 'financeiro-cockpit';

// Cada bloco é uma query própria (react-query): o mount reusa o cache (staleTime global de 60 s),
// trocar o regime só refaz a DRE, e a falha de um bloco não derruba os outros. A queryFn LANÇA —
// o fallback de erro (aging → null, inadimplentes → [], snapshots → [], balanço → sem selo) é
// aplicado na LEITURA do estado. Engolir o erro dentro da queryFn virava "sucesso" no cache: sem
// o `retry` global e reusado por 60 s a cada remontagem (parecer Codex, plano v4 lote 13). O resumo
// em erro fica INDISPONÍVEL (null) em vez de `{}` — o `{}` virava CR/CP/vencido = 0 e
// inadimplência "0,0%" verde.
function useLogarFalha(erro: unknown, mensagem: string) {
  useEffect(() => {
    if (erro) logger.warn(mensagem, { error: mensagemDeErro(erro) ?? '(sem mensagem)' });
  }, [erro, mensagem]);
}

async function lerConfiabilidade(ano: number, mes: number): Promise<FinConfiabilidadeRow[]> {
  const confResults: FinConfiabilidadeRow[] = [];
  for (const co of EMPRESAS_COCKPIT) {
    try {
      const { data: conf } = await supabase
        .from('fin_confiabilidade')
        .select('*')
        .eq('company', co)
        .eq('ano', ano)
        .eq('mes', mes)
        .maybeSingle();
      if (conf) confResults.push(conf);
    } catch (e) {
      logger.warn('Tabela fin_confiabilidade indisponível', {
        company: co,
        error: mensagemDeErro(e) ?? '(sem mensagem)',
      });
    }
  }
  return confResults;
}

// Fleuriet: balanço (master-only via RLS) + NCG histórico casado por data. Não-master não lê
// fin_balanco_inputs (RLS) → balancos {} → classificação 'indisponivel' (sem selo). A receita da
// materialidade vem da DRE na hora de classificar, então esta query não depende do regime.
interface InsumosFleuriet {
  balancos: Record<string, BalancoInputRow>;
  ncg: Record<string, { ncg: number | null; snapshot_at: string }[]>;
}
async function lerInsumosFleuriet(): Promise<InsumosFleuriet> {
  const balancos = await getBalancoInputs(EMPRESAS_COCKPIT);
  const ncg: InsumosFleuriet['ncg'] = {};
  await Promise.all(EMPRESAS_COCKPIT.map(async (co) => {
    const bal = balancos[co];
    // Só busca NCG quando há balanço; a janela é ao redor da data_ref (não desde hoje) — assim
    // um balanço antigo ainda casa com o snapshot da época sem o cap cortar (Codex).
    ncg[co] = bal
      ? await getNcgNaJanela(co, bal.data_ref).catch(() => [] as { ncg: number | null; snapshot_at: string }[])
      : [];
  }));
  return { balancos, ncg };
}

export function useFinanceiroCockpit() {
  const [drillDown, setDrillDown] = useState<DrillDownType>(null);
  const queryClient = useQueryClient();

  const { regime } = useFinanceiroRegime();
  const ano = new Date().getFullYear();
  const mes = new Date().getMonth() + 1;

  const resumoQ = useQuery({ queryKey: [QK, 'resumo'], queryFn: () => getResumoFinanceiro(EMPRESAS_COCKPIT) });
  // getAgingReceber LANÇA em erro (era EMPTY_AGING silencioso = "R$0 vencido" fabricado); o
  // fallback null é tratado como indisponível ('—'), nunca como carteira sã.
  const agingQ = useQuery({ queryKey: [QK, 'aging'], queryFn: () => getAgingReceber('all') });
  const dreQ = useQuery({
    queryKey: [QK, 'dre', ano, regime],
    queryFn: () => Promise.all(EMPRESAS_COCKPIT.map(co => getDRE(co, ano, undefined, regime))).then(r => r.flat()),
  });
  // getTopInadimplentes LANÇA em erro (era [] silencioso = falso "ninguém inadimplente").
  const inadQ = useQuery({ queryKey: [QK, 'inadimplentes'], queryFn: () => getTopInadimplentes('all', 5) });
  // Projeção 13s + NCG consolidados via snapshot real da engine A1 (não a RPC ingênua)
  const snapsQ = useQuery({ queryKey: [QK, 'snapshots'], queryFn: () => getProjecaoSnapshotsCockpit(EMPRESAS_COCKPIT) });
  const fleurietQ = useQuery({ queryKey: [QK, 'fleuriet'], queryFn: lerInsumosFleuriet });
  const confQ = useQuery({ queryKey: [QK, 'confiabilidade', ano, mes], queryFn: () => lerConfiabilidade(ano, mes) });

  useLogarFalha(resumoQ.error, 'Resumo financeiro indisponível');
  useLogarFalha(agingQ.error, 'Aging de recebíveis indisponível');
  useLogarFalha(dreQ.error, 'DRE do cockpit indisponível');
  useLogarFalha(inadQ.error, 'Top inadimplentes indisponível');
  useLogarFalha(snapsQ.error, 'Snapshots de projeção indisponíveis');
  useLogarFalha(fleurietQ.error, 'Balanço (Fleuriet) indisponível');

  const loading = resumoQ.isPending || agingQ.isPending || dreQ.isPending || inadQ.isPending || snapsQ.isPending;
  const resumo = resumoQ.data ?? null;
  const aging = agingQ.data ?? null;
  const dre = useMemo(() => dreQ.data ?? [], [dreQ.data]);
  const inadimplentes = inadQ.data ?? [];
  const confiabilidade = confQ.data ?? [];
  // Default = indisponível/parcial (Codex P1): em falha de carga, NCG não pode aparecer como R$0 "saudável".
  // Snapshots em erro = nenhuma empresa presente (o fallback `[]` de antes): consolidar marca todas ausentes.
  const cockpit = useMemo(() => {
    const snapshots = snapsQ.data ?? (snapsQ.isError ? [] : null);
    return snapshots ? consolidarCockpit({ esperadas: EMPRESAS_COCKPIT, snapshots }) : COCKPIT_VAZIO;
  }, [snapsQ.data, snapsQ.isError]);
  const fleuriet = useMemo(() => {
    const out: Record<string, ClassificacaoFleurietEmpresa> = {};
    if (!fleurietQ.data || !dreQ.data) return out;
    for (const co of EMPRESAS_COCKPIT) {
      const bal = fleurietQ.data.balancos[co];
      out[co] = classificarFleurietEmpresa({
        balanco: bal ? { anc: bal.anc, pnc: bal.pnc, pl: bal.pl, data_ref: bal.data_ref } : null,
        snapshots: fleurietQ.data.ncg[co] ?? [],
        receita_liquida_mensal: receitaLiquidaMensal(dreQ.data, co),
        hojeMs: Date.now(),
      });
    }
    return out;
  }, [fleurietQ.data, dreQ.data]);

  const recarregar = useCallback(() => queryClient.invalidateQueries({ queryKey: [QK] }), [queryClient]);

  // Computed
  // Consolidado do grupo: indisponível se faltar o saldo de qualquer CNPJ (caixa é
  // por-CNPJ, não-fungível — a parcela que falta não se estima pelas outras).
  // Resumo indisponível (null) → os totais de títulos também: o `reduce` sobre `{}` dava 0. Títulos
  // indisponíveis de um CNPJ anulam só CR/CP do grupo; o caixa segue a régua dele.
  const totalCC = resumo === null ? null : caixaDoGrupo(resumo);
  const titulosGrupo = resumo === null ? null : consolidarTitulos(Object.values(resumo));
  const totalCR = titulosGrupo?.total_a_receber ?? null;
  const totalCP = titulosGrupo?.total_a_pagar ?? null;
  const totalVencidoCR = titulosGrupo?.total_vencido_receber ?? null;
  // NCG real (ACO−PCO) consolidado da engine A1, não o CR−CP ingênuo
  const ncg = cockpit.ncg_total;
  const pctInadimplencia =
    totalCR === null || totalVencidoCR === null ? null : totalCR > 0 ? (totalVencidoCR / totalCR) * 100 : 0;

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
  // DRE que falhou → margens indisponíveis (null → '—'), não "0,0%".
  const margemBruta = dreQ.isError ? null : totalReceita > 0 ? (totalLucroBruto / totalReceita) * 100 : 0;
  const margemOp = dreQ.isError ? null : totalReceita > 0 ? (totalResultadoOp / totalReceita) * 100 : 0;

  // Risco de liquidez
  // Sem saldo conhecido não há razão de liquidez: `null`, não 0 — 0 aqui é rotulado
  // 'Alto' e pintado de vermelho, ou seja, o dado que falta viraria um veredito.
  const riscoLiquidez: number | null =
    totalCC === null || totalCP === null ? null : totalCP > 0 && totalCC > 0 ? totalCC / totalCP : 0;
  const riscoLabel =
    riscoLiquidez === null ? '—' : riscoLiquidez >= 1 ? 'Baixo' : riscoLiquidez >= 0.5 ? 'Médio' : 'Alto';
  const riscoColor =
    riscoLiquidez === null
      ? 'text-muted-foreground'
      : riscoLiquidez >= 1 ? 'text-status-success' : riscoLiquidez >= 0.5 ? 'text-status-warning' : 'text-status-error';

  // Concentração (do aging)
  // aging null = fonte INDISPONÍVEL (getAgingReceber lançou) → os derivados também são null e a
  // tela mostra "—". Antes os `: 0`/`|| 0` refabricavam "0% crítico, R$ 0" uma camada acima do
  // service — e verde, pela faixa ≤5% (achado Codex na revisão desta entrega).
  const totalAgingCR = aging
    ? aging.a_vencer_valor + aging.vencido_1_30_valor + aging.vencido_31_60_valor + aging.vencido_61_90_valor + aging.vencido_90_plus_valor
    : null;
  const agingCriticoValor = aging ? aging.vencido_61_90_valor + aging.vencido_90_plus_valor : null;
  // Carteira sem título (total 0) é zero LEGÍTIMO; só a ausência da fonte vira null.
  const pctCritico =
    totalAgingCR === null || agingCriticoValor === null ? null
      : totalAgingCR > 0 ? agingCriticoValor / totalAgingCR * 100 : 0;

  return {
    loading,
    regime,
    recarregar,
    confiabilidade,
    dreConsolidado,
    cockpit,
    fleuriet,
    inadimplentes,
    drillDown,
    setDrillDown,
    totalCC,
    totalCR,
    totalCP,
    totalVencidoCR,
    ncg,
    pctInadimplencia,
    margemBruta,
    margemOp,
    riscoLiquidez,
    riscoLabel,
    riscoColor,
    pctCritico,
    agingCriticoValor,
  };
}
