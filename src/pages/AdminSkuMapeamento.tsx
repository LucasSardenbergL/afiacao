// Mapeamento SKU — liga código interno (Omie) ao código comercial dos portais.
// Composição: useSkuMapeamento (queries/upsert/validação) + filtros + tabela + dialogs.
// God-component split de src/pages/AdminSkuMapeamento.tsx (comportamento 1:1).
import { Button } from '@/components/ui/button';
import { Plus, ShieldQuestion } from 'lucide-react';
import { useSkuMapeamento } from '@/components/skuMapeamento/useSkuMapeamento';
import { MapeamentoFiltros } from '@/components/skuMapeamento/MapeamentoFiltros';
import { MapeamentosTable } from '@/components/skuMapeamento/MapeamentosTable';
import { MapeamentoFormDialog } from '@/components/skuMapeamento/MapeamentoFormDialog';
import { ValidacaoDialog } from '@/components/skuMapeamento/ValidacaoDialog';

export default function AdminSkuMapeamento() {
  const {
    filtroEmpresa, setFiltroEmpresa,
    filtroFornecedor, setFiltroFornecedor,
    filtroAtivo, setFiltroAtivo,
    busca, setBusca,
    empresas, fornecedores,
    mapeamentos,
    isLoading,
    descricoes,
    filtrados,
    openAdd,
    handleOpenAddChange,
    closeAdd,
    isEditing,
    form, setForm,
    save,
    isSaving,
    handleEdit,
    handleNovo,
    openValidar, setOpenValidar,
    validando, validacao,
    handleValidar,
    gravarSeguros, gravandoSeguros,
  } = useSkuMapeamento();

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mapeamento SKU</h1>
          <p className="text-muted-foreground mt-1">
            Liga o código interno (Omie) ao código comercial usado nos portais de fornecedores.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleValidar}>
            <ShieldQuestion className="h-4 w-4 mr-2" />
            Validar mapeamentos
          </Button>
          <Button onClick={handleNovo}>
            <Plus className="h-4 w-4 mr-2" />
            Adicionar mapeamento
          </Button>
        </div>
      </div>

      <MapeamentoFiltros
        filtroEmpresa={filtroEmpresa}
        onFiltroEmpresaChange={setFiltroEmpresa}
        filtroFornecedor={filtroFornecedor}
        onFiltroFornecedorChange={setFiltroFornecedor}
        filtroAtivo={filtroAtivo}
        onFiltroAtivoChange={setFiltroAtivo}
        busca={busca}
        onBuscaChange={setBusca}
        empresas={empresas}
        fornecedores={fornecedores}
      />

      <MapeamentosTable
        isLoading={isLoading}
        filtrados={filtrados}
        totalCount={mapeamentos?.length ?? 0}
        descricoes={descricoes}
        onEdit={handleEdit}
      />

      {/* Add/Edit dialog */}
      <MapeamentoFormDialog
        open={openAdd}
        onOpenChange={handleOpenAddChange}
        isEditing={isEditing}
        form={form}
        setForm={setForm}
        onCancel={closeAdd}
        onSave={save}
        isSaving={isSaving}
      />

      {/* Validar dialog */}
      <ValidacaoDialog
        open={openValidar}
        onOpenChange={setOpenValidar}
        validando={validando}
        validacao={validacao}
        gravarSeguros={gravarSeguros}
        gravandoSeguros={gravandoSeguros}
      />
    </div>
  );
}
