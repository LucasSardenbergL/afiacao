// src/components/financeiro/antecipacao/MedidorCustoCard.tsx
// F4 Job A — medidor de custo do período. Headline = R$ (custo_total); a taxa a.a. é money-weighted
// (P1-2) e nunca aparece sozinha. Degrada honesto por motivo (sem_operacoes/dados_parciais) — nunca
// um R$0 travestido de "custo zero" (P1-6: "registradas", o dado é manual).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingDown, AlertTriangle, Inbox } from 'lucide-react';
import { medirCusto } from '@/lib/financeiro/antecipacao-helpers';
import type { Antecipacao } from '@/lib/financeiro/antecipacao-types';
import { fmt, fmtCompact } from '@/components/financeiro/dashboard/format';

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function MedidorCustoCard({ ops }: { ops: Antecipacao[] }) {
  const r = medirCusto(ops);

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-status-info" />
          Custo da antecipação
          {r.motivo !== 'sem_operacoes' && r.num_operacoes > 0 && (
            <Badge variant="outline" className="text-[10px] font-normal">
              {r.num_operacoes} {r.num_operacoes === 1 ? 'operação' : 'operações'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {r.motivo === 'sem_operacoes' ? (
          <div className="flex items-start gap-3 py-2">
            <Inbox className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              Sem antecipações registradas — nenhum custo a medir. (O dado é manual: registre as operações
              para acompanhar o custo.)
            </p>
          </div>
        ) : r.custo_total == null ? (
          <div className="flex items-start gap-3 py-2">
            <AlertTriangle className="w-5 h-5 text-status-warning mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-status-warning-fg">Operações inválidas</p>
              <p className="text-sm text-muted-foreground">
                As {r.num_excluidas} operação(ões) registradas têm líquido maior que a face ou prazo não
                positivo. Corrija-as para medir o custo.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <Metric label="Custo total" value={fmt(r.custo_total)} tone="error" hint="Soma dos custos das operações no período" />
              <Metric label="Volume antecipado" value={fmt(r.volume_antecipado ?? 0)} hint="Líquido recebido" />
              <Metric label="Taxa realizada (a.a.)" value={pct(r.taxa_realizada_aa)} hint="Money-weighted sobre capital×tempo" />
            </div>

            {r.num_excluidas > 0 && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-status-warning-bg border border-status-warning/30">
                <AlertTriangle className="w-4 h-4 text-status-warning mt-0.5 shrink-0" />
                <p className="text-xs text-status-warning-fg">
                  {r.num_excluidas} operação(ões) inválida(s) foram excluídas do total — o número acima é só
                  das válidas.
                </p>
              </div>
            )}

            {r.tendencia.length > 1 && (
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">Por mês (data da operação):</p>
                <div className="flex flex-wrap gap-2">
                  {r.tendencia.map((m) => (
                    <span
                      key={`${m.ano}-${m.mes}`}
                      className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground tabular-nums"
                    >
                      {MESES[m.mes - 1]}/{String(m.ano).slice(2)}: {fmtCompact(m.custo)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
  tone?: 'error';
}) {
  const color = tone === 'error' ? 'text-status-error' : '';
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}
