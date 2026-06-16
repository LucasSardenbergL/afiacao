import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, XCircle, Clock } from "lucide-react";
import { SubstituicaoPendenteCard } from "@/components/reposicao/aplicacao/SubstituicaoPendenteCard";
import { SubstituicaoModal } from "@/components/reposicao/aplicacao/SubstituicaoModal";
import { useAplicacaoFila } from "@/components/reposicao/aplicacao/useAplicacaoFila";
import { AplicacaoHeader } from "@/components/reposicao/aplicacao/AplicacaoHeader";
import { ProntosTab } from "@/components/reposicao/aplicacao/ProntosTab";
import { InativosTab } from "@/components/reposicao/aplicacao/InativosTab";
import { AplicadosTab } from "@/components/reposicao/aplicacao/AplicadosTab";
import { AplicacaoConfirmDialogs } from "@/components/reposicao/aplicacao/AplicacaoConfirmDialogs";

export default function AdminReposicaoAplicacao() {
  const {
    tab,
    setTab,
    selected,
    setSelected,
    deltaFilter,
    setDeltaFilter,
    search,
    setSearch,
    substituicaoOpen,
    setSubstituicaoOpen,
    confirmLote,
    setConfirmLote,
    confirmIndividual,
    setConfirmIndividual,
    ultimoSync,
    contadores,
    isLoading,
    filteredItens,
    hasBloqueados,
    syncDesatualizado,
    gerarFila,
    sincronizarOmie,
    aplicarIds,
    desativarSku,
    handleAplicarLote,
    toggleAll,
    invalidateFila,
  } = useAplicacaoFila();

  return (
    <div className="container mx-auto py-6 space-y-6">
      <AplicacaoHeader
        ultimoSync={ultimoSync}
        syncDesatualizado={syncDesatualizado}
        onSincronizar={() => sincronizarOmie.mutate()}
        sincronizarPending={sincronizarOmie.isPending}
        onGerarFila={() => gerarFila.mutate()}
        gerarFilaPending={gerarFila.isPending}
      />

      {syncDesatualizado && (
        <Card className="border-warning bg-warning/5">
          <CardContent className="py-3 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <span>
              Status Omie está desatualizado (&gt; 24h). Sincronize antes de aplicar para evitar
              sobrescrever alterações manuais.
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => { setTab(v); setSelected(new Set()); }}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="pronto" className="data-[state=active]:bg-success/10">
            <CheckCircle2 className="h-4 w-4 mr-2 text-success" />
            Prontos para aplicar
            {!!contadores?.pronto && (
              <Badge className="ml-2 bg-success/20 text-success">{contadores.pronto}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="inativo" className="data-[state=active]:bg-destructive/10">
            <XCircle className="h-4 w-4 mr-2 text-destructive" />
            Item inativo
            {!!contadores?.inativo && (
              <Badge className="ml-2 bg-destructive/20 text-destructive">
                {contadores.inativo}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="substituicao" className="data-[state=active]:bg-warning/10">
            <AlertTriangle className="h-4 w-4 mr-2 text-warning" />
            Substituição pendente
            {!!contadores?.substituicao && (
              <Badge className="ml-2 bg-warning/20 text-warning-foreground">
                {contadores.substituicao}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="aplicado">
            <Clock className="h-4 w-4 mr-2" />
            Aplicados (30d)
            {!!contadores?.aplicado && <Badge className="ml-2">{contadores.aplicado}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ABA 1: PRONTOS */}
        <TabsContent value="pronto" className="space-y-3">
          <ProntosTab
            filteredItens={filteredItens}
            isLoading={isLoading}
            search={search}
            setSearch={setSearch}
            deltaFilter={deltaFilter}
            setDeltaFilter={setDeltaFilter}
            selected={selected}
            setSelected={setSelected}
            toggleAll={toggleAll}
            hasBloqueados={hasBloqueados}
            aplicarPending={aplicarIds.isPending}
            onAplicarLote={handleAplicarLote}
            onConfirmIndividual={setConfirmIndividual}
          />
        </TabsContent>

        {/* ABA 2: INATIVOS */}
        <TabsContent value="inativo" className="space-y-3">
          <InativosTab
            filteredItens={filteredItens}
            isLoading={isLoading}
            onSubstituicao={setSubstituicaoOpen}
            onDesativar={(sku) => desativarSku.mutate(sku)}
          />
        </TabsContent>

        {/* ABA 3: SUBSTITUIÇÃO */}
        <TabsContent value="substituicao" className="space-y-3">
          {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {!isLoading && (filteredItens?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhuma substituição pendente.
            </p>
          )}
          {/* onChange usa invalidateFila (escopado): a versão anterior chamava
              qc.invalidateQueries() SEM key — resolver 1 substituição refazia
              TODAS as queries ativas do app numa rajada. */}
          {filteredItens.map((it) => (
            <SubstituicaoPendenteCard key={it.id} item={it} onChange={() => invalidateFila()} />
          ))}
        </TabsContent>

        {/* ABA 4: APLICADOS */}
        <TabsContent value="aplicado">
          <AplicadosTab filteredItens={filteredItens} />
        </TabsContent>
      </Tabs>

      {/* Modal substituição */}
      {substituicaoOpen && (
        <SubstituicaoModal
          item={substituicaoOpen}
          onClose={() => setSubstituicaoOpen(null)}
          onDone={() => {
            setSubstituicaoOpen(null);
            invalidateFila();
          }}
        />
      )}

      <AplicacaoConfirmDialogs
        confirmLote={confirmLote}
        setConfirmLote={setConfirmLote}
        confirmIndividual={confirmIndividual}
        setConfirmIndividual={setConfirmIndividual}
        onAplicar={(ids) => aplicarIds.mutate(ids)}
      />
    </div>
  );
}
