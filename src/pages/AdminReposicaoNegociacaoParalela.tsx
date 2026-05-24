import {
  Handshake,
  Loader2,
  RefreshCw,
  Sparkles,
  ClipboardList,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { HelpDrawer } from "@/components/help/HelpDrawer";
import { SugestaoCard } from "@/components/reposicao/negociacaoParalela/SugestaoCard";
import { RankingTable } from "@/components/reposicao/negociacaoParalela/RankingTable";
import {
  IgnorarDialog,
  FecharSemAcordoDialog,
  ConverterDialog,
} from "@/components/reposicao/negociacaoParalela/dialogs";
import { SugestoesToolbar } from "@/components/reposicao/negociacaoParalela/SugestoesToolbar";
import { RankingToolbar } from "@/components/reposicao/negociacaoParalela/RankingToolbar";
import { DistribuicaoCards } from "@/components/reposicao/negociacaoParalela/DistribuicaoCards";
import { RankingPaginacao } from "@/components/reposicao/negociacaoParalela/RankingPaginacao";
import { useNegociacaoParalela } from "@/components/reposicao/negociacaoParalela/useNegociacaoParalela";

export default function AdminReposicaoNegociacaoParalela() {
  const {
    PAGE_SIZE,
    rankingRef,
    statusFiltro,
    categoriaFiltro,
    ordenacao,
    setOrdenacao,
    toggleStatusFiltro,
    toggleCategoriaFiltro,
    rankingCategoriaFiltro,
    toggleRankingCategoria,
    rankingComSugestao,
    setRankingComSugestao,
    rankingBusca,
    onRankingBuscaChange,
    setRankingPagina,
    highlightSku,
    gerando,
    refreshing,
    ignoreTarget,
    setIgnoreTarget,
    fecharSemAcordoTarget,
    setFecharSemAcordoTarget,
    fecharObs,
    setFecharObs,
    convertTarget,
    setConvertTarget,
    convertForm,
    setConvertForm,
    convertSubmitting,
    loadingSugestoes,
    loadingRanking,
    skusComSugestao,
    sugestoesFiltradas,
    distribuicao,
    rankingFiltrado,
    totalPaginas,
    paginaAtual,
    rankingPagina_,
    ultimaAtualizacao,
    rankingMap,
    handleGerarSugestoes,
    handleRefreshRanking,
    handleMarcarVisualizada,
    handleMarcarEmAndamento,
    handleIgnorarConfirm,
    handleFecharSemAcordoConfirm,
    handleIrAoRanking,
    openConvertDialog,
    handleConverterConfirm,
    handleCriarSugestaoDoRanking,
  } = useNegociacaoParalela();

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-screen-2xl">
      {/* Breadcrumb + título */}
      <div className="space-y-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/admin/reposicao/oportunidades">Reposição</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Negociação Paralela</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Handshake className="h-7 w-7 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Negociação Paralela</h1>
          </div>
          <HelpDrawer />
        </div>
      </div>

      {/* Card explicativo */}
      <Card className="border-status-info/30 bg-status-info/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-5 w-5 text-status-info dark:text-status-info mt-0.5 shrink-0" />
          <p className="text-sm text-foreground/90 leading-relaxed">
            O sistema analisa seu histórico de compras e identifica SKUs candidatos a negociar descontos
            flat condicionais com a Sayerlack. Sugestões são geradas automaticamente; você decide quais
            vale abordar.
          </p>
        </CardContent>
      </Card>

      {/* BLOCO 1: Sugestões ativas */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">Sugestões ativas</h2>
            <p className="text-xs text-muted-foreground">
              {sugestoesFiltradas.length} sugest{sugestoesFiltradas.length === 1 ? "ão" : "ões"}
            </p>
          </div>
          <Button onClick={handleGerarSugestoes} disabled={gerando}>
            {gerando ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            Gerar novas sugestões
          </Button>
        </div>

        {/* Filtros */}
        <SugestoesToolbar
          statusFiltro={statusFiltro}
          onToggleStatus={toggleStatusFiltro}
          categoriaFiltro={categoriaFiltro}
          onToggleCategoria={toggleCategoriaFiltro}
          ordenacao={ordenacao}
          onOrdenacaoChange={setOrdenacao}
        />

        {loadingSugestoes ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Carregando sugestões...
          </div>
        ) : sugestoesFiltradas.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Nenhuma sugestão ativa no momento</p>
              <Button onClick={handleGerarSugestoes} disabled={gerando} variant="outline">
                {gerando ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                Gerar sugestões agora
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {sugestoesFiltradas.map((s) => (
              <SugestaoCard
                key={s.id}
                s={s}
                rankingExtra={rankingMap.get(s.sku_codigo_omie)}
                onMarcarVisualizada={handleMarcarVisualizada}
                onIrAoRanking={handleIrAoRanking}
                onMarcarEmAndamento={handleMarcarEmAndamento}
                onIgnorar={(sug) => setIgnoreTarget(sug)}
                onFecharSemAcordo={(sug) => setFecharSemAcordoTarget(sug)}
                onConverter={openConvertDialog}
              />
            ))}
          </div>
        )}
      </section>

      {/* BLOCO 2: Ranking completo */}
      <section ref={rankingRef} className="space-y-4 pt-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">Ranking completo de candidatos</h2>
            <p className="text-xs text-muted-foreground">
              Atualizado semanalmente via cron.
              {ultimaAtualizacao && ` Última atualização: ${ultimaAtualizacao}`}
            </p>
          </div>
          <Button variant="outline" onClick={handleRefreshRanking} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Atualizar ranking agora
          </Button>
        </div>

        {/* Distribuição */}
        <DistribuicaoCards distribuicao={distribuicao} />

        {/* Filtros ranking */}
        <RankingToolbar
          rankingCategoriaFiltro={rankingCategoriaFiltro}
          onToggleCategoria={toggleRankingCategoria}
          rankingComSugestao={rankingComSugestao}
          onComSugestaoChange={setRankingComSugestao}
          rankingBusca={rankingBusca}
          onBuscaChange={onRankingBuscaChange}
        />

        {/* Tabela */}
        <RankingTable
          rows={rankingPagina_}
          loading={loadingRanking}
          paginaAtual={paginaAtual}
          pageSize={PAGE_SIZE}
          skusComSugestao={skusComSugestao}
          highlightSku={highlightSku}
          onCriarSugestao={handleCriarSugestaoDoRanking}
        />

        {/* Paginação */}
        <RankingPaginacao
          paginaAtual={paginaAtual}
          totalPaginas={totalPaginas}
          pageSize={PAGE_SIZE}
          totalFiltrado={rankingFiltrado.length}
          onAnterior={() => setRankingPagina((p) => Math.max(1, p - 1))}
          onProxima={() => setRankingPagina((p) => Math.min(totalPaginas, p + 1))}
        />
      </section>

      {/* Dialog: ignorar */}
      <IgnorarDialog
        open={!!ignoreTarget}
        onOpenChange={(o) => !o && setIgnoreTarget(null)}
        onConfirm={handleIgnorarConfirm}
      />

      {/* Dialog: fechar sem acordo */}
      <FecharSemAcordoDialog
        open={!!fecharSemAcordoTarget}
        onOpenChange={(o) => {
          if (!o) {
            setFecharSemAcordoTarget(null);
            setFecharObs("");
          }
        }}
        obs={fecharObs}
        onObsChange={setFecharObs}
        onCancel={() => setFecharSemAcordoTarget(null)}
        onConfirm={handleFecharSemAcordoConfirm}
      />

      {/* Dialog: registrar desconto fechado (converter) */}
      <ConverterDialog
        target={convertTarget}
        form={convertForm}
        setForm={setConvertForm}
        submitting={convertSubmitting}
        onOpenChange={(o) => !o && setConvertTarget(null)}
        onCancel={() => setConvertTarget(null)}
        onConfirm={handleConverterConfirm}
      />
    </div>
  );
}
