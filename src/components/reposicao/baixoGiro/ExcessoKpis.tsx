import { fmtBRL } from "@/lib/reposicao/sku-param";
import type { KpisExcesso } from "@/lib/reposicao/excesso-helpers";

export function ExcessoKpis({ capitalExcedenteRs, capitalEstruturalRs, skusN, estruturaisN, semCustoN }: KpisExcesso) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Capital acima do máximo</div>
        <div className="kpi-value text-2xl font-semibold tnum">{fmtBRL(capitalExcedenteRs)}</div>
        {semCustoN > 0 && (
          <div className="text-xs text-status-warning">+ {semCustoN} SKU(s) sem custo conhecido</div>
        )}
      </div>
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Parcela estrutural (giro não digere em 180d)</div>
        <div className="kpi-value text-2xl font-semibold tnum">{fmtBRL(capitalEstruturalRs)}</div>
        <div className="text-xs text-muted-foreground">{estruturaisN} SKU(s)</div>
      </div>
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">SKUs em excesso</div>
        <div className="kpi-value text-2xl font-semibold tnum">{skusN}</div>
      </div>
    </div>
  );
}
