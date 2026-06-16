// Card visual do ciclo financeiro (PMR/PMP + interpretação).
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Clock } from 'lucide-react';
import type { CapitalDeGiro } from '@/services/financeiroService';

export function CicloFinanceiroCard({ active }: { active: CapitalDeGiro }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Ciclo Financeiro
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {(active.pmr === null || active.pmp === null || active.ciclo_financeiro === null) ? (
          <div className="p-4 rounded-lg bg-muted/40 border text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Prazos indisponíveis</p>
            <p className="mt-1">
              PMR/PMP/ciclo dependem da data de baixa dos títulos, que ainda não é sincronizada
              do Omie. Os demais indicadores desta tela (capital de giro, concentração, projeção)
              estão corretos.
            </p>
          </div>
        ) : (
        <>
        <div className="space-y-3">
          {/* PMR Bar */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-muted-foreground">Prazo Médio de Recebimento</span>
              <span className="font-bold">{active.pmr} dias</span>
            </div>
            <div className="h-4 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-status-info transition-all"
                style={{ width: `${Math.min((active.pmr / Math.max(active.pmr, active.pmp, 1)) * 100, 100)}%` }}
              />
            </div>
          </div>
          {/* PMP Bar */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-muted-foreground">Prazo Médio de Pagamento</span>
              <span className="font-bold">{active.pmp} dias</span>
            </div>
            <div className="h-4 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-status-success transition-all"
                style={{ width: `${Math.min((active.pmp / Math.max(active.pmr, active.pmp, 1)) * 100, 100)}%` }}
              />
            </div>
          </div>
        </div>

        <div className={`p-4 rounded-lg ${active.ciclo_financeiro > 0 ? 'bg-status-warning-bg border-status-warning/30' : 'bg-status-success-bg border-status-success/30'} border`}>
          <p className={`text-sm font-medium ${active.ciclo_financeiro > 0 ? 'text-status-warning-fg' : 'text-status-success-fg'}`}>
            {active.ciclo_financeiro > 0
              ? `Ciclo positivo de ${active.ciclo_financeiro} dias — você financia seus clientes por ${active.ciclo_financeiro} dias antes de receber.`
              : active.ciclo_financeiro < 0
                ? `Ciclo negativo de ${Math.abs(active.ciclo_financeiro)} dias — você recebe antes de pagar, gerando caixa livre.`
                : 'Ciclo neutro — recebimento e pagamento estão alinhados.'
            }
          </p>
          {active.ciclo_financeiro > 15 && (
            <p className="text-xs mt-2 text-status-warning">
              Considere: renegociar prazos com fornecedores, antecipar recebíveis, ou reduzir prazos de vendas.
            </p>
          )}
        </div>
        </>
        )}
      </CardContent>
    </Card>
  );
}
