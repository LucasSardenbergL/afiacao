import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Truck } from "lucide-react";
import { EtapaFormDialog } from "@/components/reposicao/cadeiaLogistica/EtapaFormDialog";
import { TrocaParceiroDialog } from "@/components/reposicao/cadeiaLogistica/TrocaParceiroDialog";
import { FornecedorCadeiaCard } from "@/components/reposicao/cadeiaLogistica/FornecedorCadeiaCard";
import { HistoricoCard } from "@/components/reposicao/cadeiaLogistica/HistoricoCard";
import { useCadeiaLogistica } from "@/components/reposicao/cadeiaLogistica/useCadeiaLogistica";

export default function AdminReposicaoCadeiaLogistica() {
  const {
    podeEditar,
    loadingForn,
    loadingEt,
    fornecedores,
    historico,
    expanded,
    toggleExp,
    editandoEtapa,
    setEditandoEtapa,
    novaEtapaForn,
    setNovaEtapaForn,
    trocandoParceiro,
    setTrocandoParceiro,
    etapasPorForn,
    salvarEtapaMut,
    desativarMut,
    trocarParceiroMut,
    reordenarMut,
  } = useCadeiaLogistica();

  if (loadingForn || loadingEt) {
    return (
      <div className="container mx-auto p-4 space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Truck className="h-6 w-6" /> Cadeia logística
        </h1>
        <p className="text-sm text-muted-foreground">
          Gestão das etapas logísticas por fornecedor habilitado. Mudanças
          recalculam automaticamente os parâmetros de reposição.
        </p>
      </div>

      {/* Seção 1+2: cards expansíveis */}
      <div className="space-y-4">
        {(fornecedores ?? []).map((f) => (
          <FornecedorCadeiaCard
            key={f.fornecedor_nome}
            fornecedor={f}
            lista={etapasPorForn.get(f.fornecedor_nome) ?? []}
            isOpen={expanded.has(f.fornecedor_nome)}
            podeEditar={podeEditar}
            onToggle={() => toggleExp(f.fornecedor_nome)}
            onNovaEtapa={() => setNovaEtapaForn(f.fornecedor_nome)}
            onEditar={(e) => setEditandoEtapa(e)}
            onTrocar={(e) => setTrocandoParceiro(e)}
            onDesativar={(e) => desativarMut.mutate(e)}
            onReordenar={(args) => reordenarMut.mutate(args)}
          />
        ))}
        {(!fornecedores || fornecedores.length === 0) && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nenhum fornecedor habilitado para reposição.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Seção 3: histórico */}
      <HistoricoCard historico={historico} />

      {/* Modal Adicionar/Editar */}
      <EtapaFormDialog
        open={!!novaEtapaForn || !!editandoEtapa}
        modo={editandoEtapa ? "editar" : "criar"}
        fornecedor={editandoEtapa?.fornecedor_nome ?? novaEtapaForn ?? ""}
        etapa={editandoEtapa}
        onClose={() => {
          setNovaEtapaForn(null);
          setEditandoEtapa(null);
        }}
        onSave={(payload) => {
          salvarEtapaMut.mutate({
            modo: editandoEtapa ? "editar" : "criar",
            fornecedor: editandoEtapa?.fornecedor_nome ?? novaEtapaForn ?? "",
            etapa: payload,
            etapaOriginal: editandoEtapa ?? undefined,
          });
        }}
        saving={salvarEtapaMut.isPending}
      />

      {/* Modal Trocar parceiro */}
      <TrocaParceiroDialog
        etapa={trocandoParceiro}
        onClose={() => setTrocandoParceiro(null)}
        onConfirm={(args) =>
          trocarParceiroMut.mutate({ etapa: trocandoParceiro!, ...args })
        }
        saving={trocarParceiroMut.isPending}
      />
    </div>
  );
}
