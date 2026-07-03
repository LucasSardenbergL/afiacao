// Selo de cobertura estrutural do giro (modelo Fleuriet/Braga) por empresa no Cockpit.
// Status de cobertura é o primário; a tipologia de Braga (Tipo I–VI) fica como etiqueta
// secundária no tooltip. Só renderiza quando há balanço informado (ver FinanceiroCockpit).
import { ShieldCheck, ShieldAlert, Shield, HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ClassificacaoFleurietEmpresa, StatusCobertura } from '@/lib/financeiro/fleuriet-helpers';

type Tone = 'success' | 'warning' | 'error' | 'muted';

const STATUS_META: Record<StatusCobertura, { label: string; tone: Tone; Icon: typeof Shield }> = {
  coberta:                { label: 'Giro coberto',             tone: 'success', Icon: ShieldCheck },
  operacao_financia_giro: { label: 'Operação financia o giro', tone: 'success', Icon: ShieldCheck },
  descoberta:             { label: 'Giro descoberto',          tone: 'warning', Icon: ShieldAlert },
  alto_risco:             { label: 'Alto risco (vive do ciclo)', tone: 'error', Icon: ShieldAlert },
  fronteira:              { label: 'Na fronteira',             tone: 'muted',   Icon: Shield },
  inconsistente:          { label: 'Balanço inconsistente',    tone: 'error',   Icon: ShieldAlert },
  indisponivel:           { label: 'Estrutura indisponível',   tone: 'muted',   Icon: HelpCircle },
};

// O TOM (cor) reflete a qualidade do Tipo de Braga, não só o status textual — senão um Tipo V/IV
// ("muito ruim"/"péssima") com status 'descoberta' apareceria amarelo em vez de vermelho.
const TIPO_TONE: Record<'I' | 'II' | 'III' | 'IV' | 'V' | 'VI', Tone> = {
  I: 'success', II: 'success', III: 'warning', IV: 'error', V: 'error', VI: 'warning',
};

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-status-success', warning: 'text-status-warning', error: 'text-status-error', muted: 'text-muted-foreground',
};
const TONE_BG: Record<Tone, string> = {
  success: 'bg-status-success-bg border-status-success/20',
  warning: 'bg-status-warning-bg border-status-warning/20',
  error: 'bg-status-error-bg border-status-error/20',
  muted: 'bg-muted/40 border-border',
};

const fmtBRL = (n: number | null) => n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

export function FleurietBadge({ c, empresaLabel }: { c: ClassificacaoFleurietEmpresa; empresaLabel: string }) {
  const meta = STATUS_META[c.status];
  const tone: Tone = c.tipo ? TIPO_TONE[c.tipo] : meta.tone;
  const color = TONE_TEXT[tone];
  const Icon = meta.Icon;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs ${TONE_BG[tone]}`}>
            <Icon className={`w-3 h-3 ${color}`} />
            <span className={`font-semibold ${color}`}>{empresaLabel}: {meta.label}</span>
            {c.tipo && <span className="text-muted-foreground">· Tipo {c.tipo} {c.rotulo}</span>}
            {c.cobertura != null && <span className="tabular-nums text-muted-foreground">· {c.cobertura.toFixed(2)}×</span>}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs space-y-1">
          <div className="font-semibold">Cobertura estrutural do giro (Fleuriet)</div>
          <div>CDG {fmtBRL(c.cdg)} · NCG {fmtBRL(c.ncg)} · Gap {fmtBRL(c.gap)}</div>
          {c.data_balanco && (
            <div className="text-muted-foreground">
              Balanço {c.data_balanco} · NCG {c.data_ncg?.slice(0, 10) ?? '—'} · confiança {c.confianca ?? '—'}
            </div>
          )}
          {c.motivos.length > 0 && <div className="text-muted-foreground">{c.motivos.join(' ')}</div>}
          <div className="text-muted-foreground italic">Direcional (NCG gerencial). Não substitui balanço auditado.</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
