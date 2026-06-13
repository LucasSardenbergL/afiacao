import { fmtBRL } from "@/lib/reposicao/sku-param";

export function BaixoGiroKpis({ totalRs, semCustoN, comEstoqueN, totalItens }: {
  totalRs: number; semCustoN: number; comEstoqueN: number; totalItens: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Capital parado na cauda</div>
        <div className="kpi-value text-2xl font-semibold tnum">{fmtBRL(totalRs)}</div>
        {semCustoN > 0 && (
          <div className="text-xs text-status-warning">+ {semCustoN} SKU(s) sem custo conhecido</div>
        )}
      </div>
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Itens na cauda</div>
        <div className="kpi-value text-2xl font-semibold tnum">{totalItens}</div>
      </div>
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Com estoque parado</div>
        <div className="kpi-value text-2xl font-semibold tnum">{comEstoqueN}</div>
      </div>
    </div>
  );
}
