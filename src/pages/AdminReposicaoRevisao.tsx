import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { History } from "lucide-react";
import { SkuDetailSheet } from "@/components/reposicao/SkuDetailSheet";
import { useRevisaoParametros } from "@/components/reposicao/revisao/useRevisaoParametros";
import { FiltrosCard } from "@/components/reposicao/revisao/FiltrosCard";
import { RevisaoTable } from "@/components/reposicao/revisao/RevisaoTable";
import { AprovarLoteDialog } from "@/components/reposicao/revisao/AprovarLoteDialog";

export default function AdminReposicaoRevisao() {
  const {
    empresa,
    classes,
    statusFilter,
    search,
    page,
    selected,
    openSku,
    setOpenSku,
    confirmBatch,
    setConfirmBatch,
    batchJustificativa,
    setBatchJustificativa,
    isLoading,
    rows,
    total,
    totalPages,
    selectedIds,
    selectedRows,
    aggregateImpact,
    allChecked,
    toggleAll,
    toggleClasse,
    clearClasses,
    onStatusChange,
    onSearchChange,
    onToggleSelect,
    prevPage,
    nextPage,
    approveMutation,
    updateMutation,
    promoverMutation,
  } = useRevisaoParametros();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Revisão de Parâmetros de Reposição</h1>
          <p className="text-sm text-muted-foreground">
            Aprove os parâmetros sugeridos por SKU antes da aplicação no Omie.
          </p>
          {statusFilter === "primeira_compra" && (
            <p className="text-sm text-status-info mt-1">
              Itens que vendem com recorrência mas estão fora da reposição automática. Revise a recorrência
              e clique em <strong>Promover</strong> — entram no fluxo normal de compra com uma quantidade-teste
              capada (o motor só compra se o estoque estiver baixo).
            </p>
          )}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/reposicao/historico">
            <History className="mr-2 h-4 w-4" /> Histórico
          </Link>
        </Button>
      </div>

      <FiltrosCard
        empresa={empresa}
        statusFilter={statusFilter}
        onStatusChange={onStatusChange}
        search={search}
        onSearchChange={onSearchChange}
        classes={classes}
        toggleClasse={toggleClasse}
        clearClasses={clearClasses}
      />

      <RevisaoTable
        total={total}
        page={page}
        totalPages={totalPages}
        isLoading={isLoading}
        rows={rows}
        selected={selected}
        allChecked={allChecked}
        toggleAll={toggleAll}
        onToggleSelect={onToggleSelect}
        onOpenDetail={setOpenSku}
        selectedCount={selectedIds.length}
        onAprovarSelecionados={() => setConfirmBatch(true)}
        onPrevPage={prevPage}
        onNextPage={nextPage}
        onPromover={(sku) => promoverMutation.mutate(sku)}
        promovendo={promoverMutation.isPending}
      />

      <SkuDetailSheet
        sku={openSku}
        onClose={() => setOpenSku(null)}
        onApprove={(justificativa) =>
          openSku && approveMutation.mutate({ ids: [openSku.id], justificativa })
        }
        onSaveValues={(values) =>
          openSku && updateMutation.mutate({ id: openSku.id, values })
        }
        isApproving={approveMutation.isPending}
        isSaving={updateMutation.isPending}
      />

      <AprovarLoteDialog
        open={confirmBatch}
        onOpenChange={setConfirmBatch}
        aggregateImpact={aggregateImpact}
        selectedRows={selectedRows}
        batchJustificativa={batchJustificativa}
        setBatchJustificativa={setBatchJustificativa}
        onConfirm={() =>
          approveMutation.mutate({ ids: selectedIds, justificativa: batchJustificativa })
        }
        isApproving={approveMutation.isPending}
      />
    </div>
  );
}
