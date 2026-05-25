// Rodapé "Base dos números" do Cockpit financeiro.
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import { Info } from 'lucide-react';

export function DataBasisFooter() {
  return (
    <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg space-y-1">
      <p className="font-medium flex items-center gap-1"><Info className="w-3 h-3" /> Base dos números</p>
      <p>Saldo bancário: consulta direta Omie (ResumirContaCorrente). CR/CP: títulos sincronizados (últimos 6 meses). DRE: regime de caixa (pagamento/recebimento efetivo). Projeção 13 semanas: baseada em vencimentos de títulos abertos.</p>
      <p>Para números de controller, verifique: % mapeado ≥ 80%, conciliação ≥ 70%, mês fechado.</p>
    </div>
  );
}
