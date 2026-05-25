// Aumentos anunciados — reajustes de preços anunciados pelos fornecedores.
// Composição: useAumentos (dados/filtros/upload) + banner + filtros + grupos + modal.
// God-component split de src/pages/AdminReposicaoAumentos.tsx (comportamento 1:1).
import { useNavigate } from "react-router-dom";
import { TrendingUp, Upload, FilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAumentos } from "@/components/reposicao/aumentos/useAumentos";
import { AtivosAguardandoBanner } from "@/components/reposicao/aumentos/AtivosAguardandoBanner";
import { AumentosFiltros } from "@/components/reposicao/aumentos/AumentosFiltros";
import { AumentosGrupos } from "@/components/reposicao/aumentos/AumentosGrupos";
import { UploadDialog } from "@/components/reposicao/aumentos/UploadDialog";

export default function AdminReposicaoAumentos() {
  const navigate = useNavigate();

  const {
    fornecedores,
    isLoading,
    ativosAguardando,
    grupos,
    isCollapsed,
    toggleMes,
    filtroFornecedor,
    setFiltroFornecedor,
    filtroEstado,
    setFiltroEstado,
    busca,
    setBusca,
    uploadOpen,
    setUploadOpen,
    arquivo,
    extraindo,
    fileInputRef,
    handleFileChange,
    resetUpload,
    handleExtrair,
  } = useAumentos();

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Aumentos anunciados</h1>
            <p className="text-sm text-muted-foreground">
              Reajustes de preços anunciados pelos fornecedores
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4" /> Upload PDF
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("/admin/reposicao/aumentos/novo")}
          >
            <FilePlus className="h-4 w-4" /> Novo aumento
          </Button>
        </div>
      </header>

      {ativosAguardando > 0 && filtroEstado !== "ativo" && (
        <AtivosAguardandoBanner
          count={ativosAguardando}
          onVerAtivos={() => setFiltroEstado("ativo")}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Anúncios</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AumentosFiltros
            filtroFornecedor={filtroFornecedor}
            onFiltroFornecedorChange={setFiltroFornecedor}
            filtroEstado={filtroEstado}
            onFiltroEstadoChange={setFiltroEstado}
            busca={busca}
            onBuscaChange={setBusca}
            fornecedores={fornecedores}
          />

          <AumentosGrupos
            isLoading={isLoading}
            grupos={grupos}
            isCollapsed={isCollapsed}
            onToggleMes={toggleMes}
            onUploadClick={() => setUploadOpen(true)}
            onRowClick={(id) => navigate(`/admin/reposicao/aumentos/${id}`)}
          />
        </CardContent>
      </Card>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={(o) => {
          if (!extraindo) {
            setUploadOpen(o);
            if (!o) resetUpload();
          }
        }}
        arquivo={arquivo}
        onFileChange={handleFileChange}
        onCancel={() => {
          setUploadOpen(false);
          resetUpload();
        }}
        onExtrair={handleExtrair}
        extraindo={extraindo}
        fileInputRef={fileInputRef}
      />
    </div>
  );
}
