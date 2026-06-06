import { SkuDetailSheet } from "@/components/reposicao/SkuDetailSheet";
import { useRevisaoParametros } from "@/components/reposicao/revisao/useRevisaoParametros";
import { FiltrosCard } from "@/components/reposicao/revisao/FiltrosCard";
import { RevisaoTable } from "@/components/reposicao/revisao/RevisaoTable";

// "Ajuste manual" — conteúdo da aba de Parâmetros (AdminReposicaoParametros) e alvo do
// redirect /admin/reposicao/revisao. Sem chrome de página própria (container/h1/Histórico):
// o cockpit já fornece título + pointer card; "Histórico" é uma aba do cockpit.
export default function AdminReposicaoRevisao() {
  const {
    empresa,
    classes,
    statusFilter,
    search,
    page,
    openSku,
    setOpenSku,
    isLoading,
    rows,
    total,
    totalPages,
    toggleClasse,
    clearClasses,
    onStatusChange,
    onSearchChange,
    prevPage,
    nextPage,
    updateMutation,
    promoverMutation,
  } = useRevisaoParametros();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Os parâmetros são ajustados automaticamente todo dia. Use esta tela pra travar um mínimo de
        compra por SKU, editar valores na mão ou promover um candidato de 1ª compra.
      </p>
      {statusFilter === "primeira_compra" && (
        <p className="text-sm text-status-info">
          Itens que vendem com recorrência mas estão fora da reposição automática. Revise a recorrência
          e clique em <strong>Promover</strong> — entram no fluxo normal de compra com uma quantidade-teste
          capada (o motor só compra se o estoque estiver baixo).
        </p>
      )}

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
        onOpenDetail={setOpenSku}
        onPrevPage={prevPage}
        onNextPage={nextPage}
        onPromover={(sku) => promoverMutation.mutate(sku)}
        promovendo={promoverMutation.isPending}
      />

      <SkuDetailSheet
        sku={openSku}
        onClose={() => setOpenSku(null)}
        onSaveValues={(values) =>
          openSku && updateMutation.mutate({ id: openSku.id, values })
        }
        isSaving={updateMutation.isPending}
      />
    </div>
  );
}
