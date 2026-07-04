// src/components/financeiro/endividamento/IndicadoresEndividamento.tsx
// Painel de indicadores do endividamento (F1). Consome APENAS os helpers puros já provados.
// ⚠️ money-path: o DSCR-caixa só ganha cor/faixa (semáforo) quando motivo==='ok'.
// Fora disso, card NEUTRO "inconclusivo" com a razão amigável — NUNCA fabrica índice/semáforo.
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  servicoDivida,
  dscrCaixa,
  saldoDevedorEmAberto,
  pctCurtoPrazo,
} from '@/lib/financeiro/endividamento-helpers';
import type { Divida, Parcela, DscrMotivo } from '@/lib/financeiro/endividamento-types';

const brl = (x: number | null | undefined) =>
  x == null
    ? '—'
    : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);

/** hoje + 12 meses em ISO YYYY-MM-DD (limite do curto prazo). */
function ate12mISO(hojeISO: string): string {
  const d = new Date(`${hojeISO}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

const MOTIVO_MSG: Record<Exclude<DscrMotivo, 'ok'>, string> = {
  inconclusivo:
    'Marque o cadastro como completo e informe, em cada dívida, se ela já está no contas-a-pagar.',
  sem_geracao: 'Aguardando projeção de caixa da empresa.',
  sem_divida: 'Sem dívida no período.',
};

interface Props {
  dividas: Divida[];
  parcelas: Parcela[];
  completo: boolean;
  geracaoOperacionalA1: number | null;
  hojeISO: string;
  fimISO: string;
}

export function IndicadoresEndividamento({
  dividas,
  parcelas,
  completo,
  geracaoOperacionalA1,
  hojeISO,
  fimISO,
}: Props) {
  // Sem horizonte válido (projeção A1 ausente) → não dá pra calcular serviço/DSCR de forma honesta.
  const horizonteOk = Boolean(hojeISO) && Boolean(fimISO);

  const ativas = dividas.filter((d) => d.ativo);
  const dividaTotal = ativas.reduce((s, d) => s + saldoDevedorEmAberto(d, parcelas), 0);

  const servico = horizonteOk
    ? servicoDivida(ativas, parcelas, hojeISO, fimISO)
    : { vencido: 0, aVencer: 0, total: 0 };

  const curto = horizonteOk ? pctCurtoPrazo(dividas, parcelas, ate12mISO(hojeISO)) : null;

  const dscr = horizonteOk
    ? dscrCaixa({ geracaoOperacionalA1, dividas, parcelas, hojeISO, fimISO, completo })
    : { valor: null, motivo: 'sem_geracao' as DscrMotivo };

  return (
    <div className="space-y-4">
      {/* ── KPIs de topo ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">Dívida total (saldo em aberto)</p>
            <p className="kpi-value text-xl mt-0.5 font-tabular">{brl(dividaTotal)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">Serviço da dívida (13 semanas)</p>
            <p className="kpi-value text-xl mt-0.5 font-tabular">{brl(servico.total)}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              <span className={servico.vencido > 0 ? 'text-status-error' : 'text-muted-foreground'}>
                Vencido {brl(servico.vencido)}
              </span>
              <span className="text-muted-foreground">A vencer {brl(servico.aVencer)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">% curto prazo (≤12m)</p>
            <p className="kpi-value text-xl mt-0.5 font-tabular">{pct(curto)}</p>
            {curto != null && (
              <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-foreground/60"
                  style={{ width: `${Math.min(100, Math.max(0, curto * 100))}%` }}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── DSCR-caixa (money-path) ── */}
      <DscrCard
        motivo={dscr.motivo}
        valor={dscr.valor}
        servicoTotal={servico.total}
        geracao={geracaoOperacionalA1}
      />

      {/* ── Caveat fixo ── */}
      <p className="text-xs text-muted-foreground">
        Direcional, não substitui balanço/contador. Serviço da dívida do cadastro manual.
      </p>
    </div>
  );
}

// ─── Card do DSCR ────────────────────────────────────────────────────────────────

function faixaDscr(v: number): { cls: string; rotulo: string } {
  if (v < 1) return { cls: 'text-status-error', rotulo: 'Cobertura insuficiente' };
  if (v <= 1.2) return { cls: 'text-status-warning', rotulo: 'Cobertura apertada' };
  return { cls: 'text-status-success', rotulo: 'Cobertura confortável' };
}

function DscrCard({
  motivo,
  valor,
  servicoTotal,
  geracao,
}: {
  motivo: DscrMotivo;
  valor: number | null;
  servicoTotal: number;
  geracao: number | null;
}) {
  // Caminho OK: ÚNICO lugar com cor/faixa/semáforo.
  if (motivo === 'ok' && valor != null) {
    const { cls, rotulo } = faixaDscr(valor);
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">DSCR-caixa (13 semanas)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="flex items-baseline gap-3">
            <span className={`text-3xl font-tabular font-medium ${cls}`}>{valor.toFixed(2)}x</span>
            <span className={`text-sm ${cls}`}>{rotulo}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Geração de caixa operacional ÷ serviço da dívida no horizonte. Abaixo de 1,0x o caixa
            não cobre as parcelas do período.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Caminho NÃO-OK: card neutro, sem semáforo. Mostra a razão + serviço e geração lado a lado.
  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-muted-foreground">
          Cobertura de caixa inconclusiva
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {motivo === 'ok' ? MOTIVO_MSG.inconclusivo : MOTIVO_MSG[motivo]}
        </p>
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-xs text-muted-foreground">Serviço da dívida (13 sem.)</p>
            <p className="text-lg font-tabular font-medium">{brl(servicoTotal)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Geração de caixa (A1)</p>
            <p className="text-lg font-tabular font-medium">{brl(geracao)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
