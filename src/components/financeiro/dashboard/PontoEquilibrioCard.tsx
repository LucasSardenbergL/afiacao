// src/components/financeiro/dashboard/PontoEquilibrioCard.tsx
// F3 — Card do ponto de equilíbrio operacional na DRE (PEGN erro 7).
// Master-only (v1; a classificação é master-only — widen p/ staff é v2). OBEN-only (spec §5).
// Disclosure OBRIGATÓRIO do excluído não-operacional (dívida/amortização) — delta-E3/E4.
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Target, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePontoEquilibrio } from '@/hooks/usePontoEquilibrio';
import { fmt, fmtCompact } from '@/components/financeiro/dashboard/format';
import type { MotivoPE } from '@/lib/financeiro/ponto-equilibrio-helpers';
import { ClassificacaoCustoDialog } from './ClassificacaoCustoDialog';

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

// Mensagem honesta por motivo de degradação (nunca finge um número).
const MOTIVO_MSG: Record<Exclude<MotivoPE, 'ok'>, { titulo: string; texto: string }> = {
  sem_dados: { titulo: 'Sem dados', texto: 'Não há snapshots de DRE (competência) para o período.' },
  sem_receita: { titulo: 'Sem receita', texto: 'Sem receita no período — o ponto de equilíbrio é indefinido.' },
  mc_negativa: {
    titulo: 'Margem de contribuição negativa',
    texto: 'Os custos variáveis superam a receita — a operação perde em cada venda. Não existe ponto de equilíbrio: reveja preço/custo antes de projetar volume.',
  },
  inconclusivo: {
    titulo: 'Classificação incompleta',
    texto: 'Falta classificar categorias materiais como fixo/variável/não-operacional. Classifique os custos para calcular o PE (não fabricamos um número otimista).',
  },
  custo_misto_material: {
    titulo: 'Custo semivariável relevante',
    texto: 'Um custo classificado "misto" é grande demais para o modelo binário fixo/variável. Refine a classificação desse código.',
  },
  snapshot_inconsistente: {
    titulo: 'Snapshot inconsistente',
    texto: 'Os totais do detalhamento não fecham com a DRE oficial (>1%). PE suspenso até o dado reconciliar.',
  },
  mc_instavel: {
    titulo: 'Margem instável',
    texto: 'A margem de contribuição oscila demais nos 12 meses (mix/margem não estável) — um PE médio seria enganoso.',
  },
  deducoes_coluna_inesperada: {
    titulo: 'Risco de dupla contagem',
    texto: 'A coluna de deduções veio preenchida — os impostos podem estar contados duas vezes. PE suspenso até mapear a fonte.',
  },
  valor_negativo_inesperado: {
    titulo: 'Sinal ambíguo',
    texto: 'Há despesa com valor negativo no detalhamento (estorno/devolução). O sinal é ambíguo e infla a margem por acidente — PE suspenso.',
  },
};

export function PontoEquilibrioCard({ company }: { company: string }) {
  const { isMaster } = useAuth();
  const { data, isLoading, meses } = usePontoEquilibrio(company);
  const [abrirClassif, setAbrirClassif] = useState(false);

  // v1: master-only (a classificação é master-only). Não-master não vê o card.
  if (!isMaster) return null;

  const n = meses.length || 1;
  const abrir = (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAbrirClassif(true)}>
      <SlidersHorizontal className="w-3.5 h-3.5" />
      Classificar custos
    </Button>
  );

  return (
    <>
      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="w-4 h-4 text-status-info" />
            Ponto de equilíbrio operacional
            {data?.periodo_label && (
              <Badge variant="outline" className="text-[10px] font-normal">
                {data.periodo_label} · receita bruta
              </Badge>
            )}
          </CardTitle>
          {abrir}
        </CardHeader>
        <CardContent>
          {isLoading || !data ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Calculando…</p>
          ) : data.motivo !== 'ok' ? (
            <div className="flex items-start gap-3 py-2">
              <AlertTriangle className="w-5 h-5 text-status-warning mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-status-warning-fg">{MOTIVO_MSG[data.motivo].titulo}</p>
                <p className="text-sm text-muted-foreground">{MOTIVO_MSG[data.motivo].texto}</p>
                {data.cobertura_pct != null && data.motivo === 'inconclusivo' && (
                  <p className="text-xs text-muted-foreground">
                    Cobertura atual: {pct(data.cobertura_pct)} do valor das despesas classificado.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Metric
                  label="PE (receita/mês)"
                  value={fmt((data.pe_receita ?? 0) / n)}
                  hint="Receita bruta mínima que zera o resultado operacional"
                />
                <Metric label="Margem de contribuição" value={pct(data.mc_pct)} />
                <Metric label="Custos fixos/mês" value={fmt((data.custos_fixos ?? 0) / n)} />
                <Metric
                  label="Margem de segurança"
                  value={pct(data.margem_seguranca_pct)}
                  tone={(data.margem_seguranca_pct ?? 0) >= 0 ? 'success' : 'error'}
                  hint={
                    (data.margem_seguranca_pct ?? 0) >= 0
                      ? 'Quanto a receita pode cair antes de zerar'
                      : 'Receita abaixo do ponto de equilíbrio'
                  }
                />
              </div>

              {/* Disclosure OBRIGATÓRIO (delta-E3): a dívida excluída pode ser enorme (até 38% das saídas). */}
              {data.excluido_nao_operacional_ttm > 0 && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-status-warning-bg border border-status-warning/30">
                  <AlertTriangle className="w-4 h-4 text-status-warning mt-0.5 shrink-0" />
                  <p className="text-xs text-status-warning-fg">
                    PE <strong>operacional</strong> — NÃO inclui{' '}
                    <strong>{fmt(data.excluido_nao_operacional_ttm / n)}/mês</strong> de amortização de
                    dívida/parcelamentos (não-operacional, {pct(data.nao_operacional_share_pct)} das saídas; último
                    mês {fmtCompact(data.excluido_nao_operacional_recente)}). A operação cobrir o PE não significa
                    caixa positivo — ver <strong>Endividamento</strong>.
                  </p>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Assume o mesmo mix/margem do período. Base run-rate de {meses.length} {meses.length === 1 ? 'mês' : 'meses'}.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {abrirClassif && (
        <ClassificacaoCustoDialog company={company} open={abrirClassif} onOpenChange={setAbrirClassif} />
      )}
    </>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'error';
}) {
  const color = tone === 'success' ? 'text-status-success' : tone === 'error' ? 'text-status-error' : '';
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}
