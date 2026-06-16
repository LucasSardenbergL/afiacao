// SLA de fornecedor — compliance de lead time por SKU e por fornecedor.
// Composição: useSlaFornecedor (dados/filtros) + cards + filtros + tabela + modal de histórico.
// God-component split de src/pages/AdminReposicaoSlaFornecedor.tsx (comportamento 1:1).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { useSlaFornecedor } from "@/components/reposicao/slaFornecedor/useSlaFornecedor";
import { ComplianceCardsGrid } from "@/components/reposicao/slaFornecedor/ComplianceCardsGrid";
import { SlaFiltros } from "@/components/reposicao/slaFornecedor/SlaFiltros";
import { StatusChips } from "@/components/reposicao/slaFornecedor/StatusChips";
import { SkuComplianceTable } from "@/components/reposicao/slaFornecedor/SkuComplianceTable";
import { SkuHistoricoDialog } from "@/components/reposicao/slaFornecedor/SkuHistoricoDialog";

export default function AdminReposicaoSlaFornecedor() {
  const {
    fornecedores,
    loadingFor,
    loadingSkus,
    skusFiltrados,
    historico,
    loadingHist,
    grupos,
    fornecedoresOptions,
    filtroFornecedor,
    setFiltroFornecedor,
    filtroTendencia,
    setFiltroTendencia,
    filtroGrupo,
    setFiltroGrupo,
    busca,
    setBusca,
    filtroStatus,
    toggleStatus,
    skuDetalhe,
    setSkuDetalhe,
    exportCsv,
  } = useSlaFornecedor();

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SLA de fornecedor</h1>
          <p className="text-sm text-muted-foreground">
            Compliance de lead time por SKU e por fornecedor — evidência objetiva pra negociação.
          </p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!fornecedores?.length}>
          <Download className="h-4 w-4 mr-2" /> Exportar CSV
        </Button>
      </div>

      {/* Cards de compliance global */}
      <ComplianceCardsGrid fornecedores={fornecedores} loading={loadingFor} />

      {/* Tabela detalhada por SKU */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Compliance por SKU</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Filtros */}
          <SlaFiltros
            filtroFornecedor={filtroFornecedor}
            onFiltroFornecedorChange={setFiltroFornecedor}
            filtroTendencia={filtroTendencia}
            onFiltroTendenciaChange={setFiltroTendencia}
            filtroGrupo={filtroGrupo}
            onFiltroGrupoChange={setFiltroGrupo}
            busca={busca}
            onBuscaChange={setBusca}
            fornecedoresOptions={fornecedoresOptions}
            grupos={grupos}
          />

          {/* Status multi-select como chips */}
          <StatusChips filtroStatus={filtroStatus} onToggle={toggleStatus} />

          {/* Tabela */}
          <SkuComplianceTable skus={skusFiltrados} loading={loadingSkus} onSelectSku={setSkuDetalhe} />
        </CardContent>
      </Card>

      {/* Modal: histórico do SKU */}
      <SkuHistoricoDialog
        skuDetalhe={skuDetalhe}
        onOpenChange={(o) => !o && setSkuDetalhe(null)}
        historico={historico}
        loadingHist={loadingHist}
      />
    </div>
  );
}
