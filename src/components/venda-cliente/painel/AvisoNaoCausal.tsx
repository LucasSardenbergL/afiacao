import { Scale } from 'lucide-react';

/**
 * Aviso FIXO do painel: sem grupo controle (decisão do founder), toda comparação aqui é
 * antes × depois. Não sai da tela em nenhum estado — nem com dado, nem vazio, nem com erro.
 */
export function AvisoNaoCausal() {
  return (
    <div
      role="note"
      aria-label="Antes × depois, não é prova causal"
      className="flex items-start gap-3 rounded-md border border-status-warning/40 bg-status-warning-bg px-4 py-3"
    >
      <Scale className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" aria-hidden />
      <div className="space-y-0.5 text-sm">
        <p className="font-medium text-foreground">Antes × depois, não é prova causal.</p>
        <p className="text-muted-foreground">
          A lista não tem grupo controle: carteira, mercado e época do ano mudam entre os períodos comparados.
          Leia a diferença como sinal operacional, não como efeito do app.
        </p>
      </div>
    </div>
  );
}
