import { Loader2, BarChart3 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useMinhasVisitasResultado } from '@/hooks/useMinhasVisitasResultado';
import { agruparVisitasPorResultado } from '@/lib/visitas/conversao';
import { visitResultLabel } from '@/lib/visitas/visit-result';
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';
import { estadoDeLeitura, naoConsegui, desatualizado } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

const JANELA_DIAS = 90;

const toneBar: Record<string, string> = {
  success: 'bg-status-success',
  info: 'bg-status-info',
  error: 'bg-status-error',
  warning: 'bg-status-warning',
  muted: 'bg-muted-foreground/40',
};
const toneText: Record<string, string> = {
  success: 'text-status-success',
  info: 'text-status-info',
  error: 'text-status-error',
  warning: 'text-status-warning',
  muted: 'text-muted-foreground',
};

/**
 * Breakdown das visitas do vendedor logado por resultado (últimos 90 dias) + receita.
 * Read-only, own-scoped. Self-hide quando não há visita na janela — VERIFICADO.
 *
 * CLASSE "erro colapsado em vazio" (docs/historico/fase-sem-sinal.md), pela porta do
 * IRMÃO: o hook LANÇA quando o SELECT falha, `data` fica `undefined`, o `data ?? []`
 * degrada a ausência para vazio e `resumo.total === 0` apaga o card — a falha de leitura
 * chegava ao vendedor como "nenhuma visita em 90 dias". `route_visits` tem 0 linhas hoje
 * (psql-ro, 2026-08-23); o gatilho é a primeira visita registrada.
 */
export function MinhasVisitasResultadoCard() {
  const q = useMinhasVisitasResultado(JANELA_DIAS);
  const { data } = q;
  const estado = estadoDeLeitura(q);

  // Sem NADA em mãos: avisa em vez de afirmar "nenhuma visita na janela".
  if (naoConsegui(estado) && !data) {
    return (
      <Card className="p-3">
        <AvisoLeituraFalhou oque="o resultado das suas visitas" estado={estado} className="mb-0" />
      </Card>
    );
  }
  // Com o breakdown em mãos e um refetch que falhou, o card FICA e declara a idade.
  const velho = desatualizado(q, Boolean(data));

  if (estado === 'carregando') {
    return (
      <Card className="p-3 flex items-center text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />Carregando resultado das visitas…
      </Card>
    );
  }

  // `data ?? []` agora é ausência VERIFICADA: os estados sem leitura saíram acima, e o
  // que sobra aqui (`desabilitada`, sem uid) é a pergunta que não foi feita.
  const resumo = agruparVisitasPorResultado(data ?? []);
  if (resumo.total === 0) return null; // self-hide — zero verificado

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BarChart3 className="w-4 h-4 text-muted-foreground" />
          Resultado das suas visitas
          <span className="text-2xs text-muted-foreground font-normal">· {JANELA_DIAS} dias</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {resumo.total} visita{resumo.total > 1 ? 's' : ''}
          {resumo.receitaTotal > 0 && <span className="text-status-success font-medium"> · {formatBRL(resumo.receitaTotal)}</span>}
        </div>
      </div>

      {velho && <AvisoLeituraFalhou oque="a leitura mais recente" estado={velho} className="mb-0" />}

      <div className="space-y-1.5">
        {resumo.buckets.map((b) => {
          const r = visitResultLabel(b.result === 'sem_resultado' ? null : b.result);
          return (
            <div key={b.result} className="space-y-0.5">
              <div className="flex items-center justify-between text-xs">
                <span className={`font-medium ${toneText[r.tone]}`}>{r.emoji} {r.label}</span>
                <span className="text-muted-foreground">
                  {b.count} ({formatarFracaoPct(b.pct)})
                  {b.revenue > 0 && <span className="text-status-success"> · {formatBRL(b.revenue)}</span>}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div className={`h-full ${toneBar[r.tone]}`} style={{ width: `${Math.round(b.pct * 100)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
