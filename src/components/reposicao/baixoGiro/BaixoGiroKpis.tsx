import { fmtBRL } from "@/lib/reposicao/sku-param";
import { LIMIAR_GIRO_MORTO_DIAS, type somarCapitalMorto } from "@/lib/reposicao/baixo-giro-helpers";

export function BaixoGiroKpis({ totalRs, semCustoN, comEstoqueN, totalItens, morto }: {
  totalRs: number; semCustoN: number; comEstoqueN: number; totalItens: number;
  morto: ReturnType<typeof somarCapitalMorto>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Capital parado na cauda</div>
        <div className="kpi-value text-2xl font-semibold tnum">{fmtBRL(totalRs)}</div>
        {semCustoN > 0 && (
          <div className="text-xs text-status-warning">+ {semCustoN} SKU(s) sem custo conhecido</div>
        )}
      </div>
      <div className="rounded-md border p-4">
        <div className="text-xs text-muted-foreground">Giro morto (≥{LIMIAR_GIRO_MORTO_DIAS}d sem venda)</div>
        <div className="kpi-value text-2xl font-semibold tnum">{fmtBRL(morto.totalRs)}</div>
        <div className="text-xs text-muted-foreground">
          {morto.mortosN} SKU(s), {morto.comEstoqueN} com estoque
          {morto.semCustoN > 0 ? ` · ${morto.semCustoN} sem custo` : ""}
        </div>
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
