// Rodapé "Base dos números" do Cockpit financeiro.
import { Info } from 'lucide-react';

export function DataBasisFooter({ regime }: { regime: 'caixa' | 'competencia' }) {
  const regimeLabel = regime === 'caixa' ? 'regime de caixa (pagamento/recebimento efetivo)' : 'regime de competência (data de emissão)';
  return (
    <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg space-y-1">
      <p className="font-medium flex items-center gap-1"><Info className="w-3 h-3" /> Base dos números</p>
      <p>Saldo bancário: consulta direta Omie (ResumirContaCorrente). CR/CP: títulos sincronizados. DRE: {regimeLabel} — alterne no seletor acima. Projeção 13 semanas + NCG: engine A1 (snapshot diário; curvas de cobrança calibradas, inadimplência, eventos, folha), consolidado das 3 empresas.</p>
      <p>Para números de controller, verifique: % mapeado ≥ 80%, conciliação ≥ 70%, mês fechado.</p>
    </div>
  );
}
