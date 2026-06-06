import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ColKey, PedidoItem } from "@/types/reposicao";
import { TabFallback } from "./TabFallback";
import { type CicloFilters } from "./cicloHoje/types";
import { useCicloHoje } from "./cicloHoje/useCicloHoje";
import { PedidoRow } from "./cicloHoje/PedidoRow";
import { FiltersToolbar } from "./cicloHoje/FiltersToolbar";
import { AutoApproveDialog } from "./cicloHoje/AutoApproveDialog";
import { BatchActionsBar } from "./cicloHoje/BatchActionsBar";

// Re-exporta ALL para preservar o import existente (AdminReposicaoSessaoPedidos).
export { ALL } from "./cicloHoje/types";

export function CicloHojePanel({
  user,
  reviewMode,
  setReviewMode,
  filters,
  setFilters,
  filteredItems,
  fornecedores,
  statuses,
  isLoading,
  cols,
  onColChange,
}: {
  user: { id?: string; email?: string | null } | null;
  reviewMode: boolean;
  setReviewMode: (b: boolean) => void;
  filters: CicloFilters;
  setFilters: (f: CicloFilters) => void;
  filteredItems: PedidoItem[];
  fornecedores: string[];
  statuses: string[];
  isLoading: boolean;
  cols: Record<ColKey, boolean>;
  onColChange: (k: ColKey, v: boolean) => void;
}) {
  const {
    selected,
    busy,
    confirmAuto,
    setConfirmAuto,
    allChecked,
    toggleAll,
    toggleOne,
    totalSelectedValue,
    eligibleAutoItems,
    autoApprovalGroups,
    manualReviewItems,
    invalidate,
    runBatch,
    runAutoApprove,
    clearFilters,
  } = useCicloHoje({ user, reviewMode, filteredItems, setFilters });

  return (
    <div className="space-y-4">
      <FiltersToolbar
        filters={filters}
        setFilters={setFilters}
        fornecedores={fornecedores}
        statuses={statuses}
        eligibleAutoCount={eligibleAutoItems.length}
        busy={busy}
        onOpenAuto={() => setConfirmAuto(true)}
        reviewMode={reviewMode}
        setReviewMode={setReviewMode}
        cols={cols}
        onColChange={onColChange}
        onClearFilters={clearFilters}
      />

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">Pedidos do ciclo ({filteredItems.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <TabFallback />
          ) : filteredItems.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Nenhum pedido para os filtros atuais.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {reviewMode && (
                    <TableHead className="w-[40px]">
                      <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
                    </TableHead>
                  )}
                  {cols.fornecedor && <TableHead>Fornecedor</TableHead>}
                  {cols.grupo && <TableHead>Grupo</TableHead>}
                  {cols.skus && <TableHead className="text-right">SKUs</TableHead>}
                  {cols.valor && <TableHead className="text-right">Valor</TableHead>}
                  {cols.preco && <TableHead className="text-right">Preço</TableHead>}
                  {cols.confianca && <TableHead>Confiança</TableHead>}
                  {cols.status && <TableHead>Status</TableHead>}
                  {cols.qtdAprovada && <TableHead className="text-right">Qtd Aprovada</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((r) => (
                  <PedidoRow
                    key={r.id}
                    row={r}
                    reviewMode={reviewMode}
                    selected={selected.has(r.id)}
                    onToggle={() => toggleOne(r.id)}
                    cols={cols}
                    user={user}
                    onChanged={invalidate}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AutoApproveDialog
        open={confirmAuto}
        onOpenChange={setConfirmAuto}
        eligibleCount={eligibleAutoItems.length}
        autoApprovalGroups={autoApprovalGroups}
        manualReviewItems={manualReviewItems}
        busy={busy}
        onConfirm={runAutoApprove}
      />

      {reviewMode && selected.size > 0 && (
        <BatchActionsBar
          count={selected.size}
          totalValue={totalSelectedValue}
          busy={busy}
          onReject={() => runBatch("reject")}
          onApprove={() => runBatch("approve")}
        />
      )}
    </div>
  );
}
