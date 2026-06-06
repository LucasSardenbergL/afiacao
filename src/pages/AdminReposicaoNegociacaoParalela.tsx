import { Handshake, Loader2, ClipboardList, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { HelpDrawer } from "@/components/help/HelpDrawer";
import { OportunidadeCard } from "@/components/reposicao/negociacaoParalela/OportunidadeCard";
import { SugestaoCard } from "@/components/reposicao/negociacaoParalela/SugestaoCard";
import { FecharSemAcordoDialog, ConverterDialog } from "@/components/reposicao/negociacaoParalela/dialogs";
import { useNegociacaoParalela } from "@/components/reposicao/negociacaoParalela/useNegociacaoParalela";
import { DESCONTO_PADRAO } from "@/lib/reposicao/negociacao-valor-helpers";

export default function AdminReposicaoNegociacaoParalela() {
  const {
    loadingFila, loadingAndamento, fila, emAndamento,
    descontoDe, setDesconto, handleVouNegociar,
    convertTarget, setConvertTarget, convertForm, setConvertForm, convertSubmitting,
    openConvertDialog, handleConverterConfirm,
    fecharSemAcordoTarget, setFecharSemAcordoTarget, fecharObs, setFecharObs, handleFecharSemAcordoConfirm,
  } = useNegociacaoParalela();

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-screen-2xl">
      <div className="space-y-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem><BreadcrumbLink href="/admin/reposicao/oportunidades">Reposição</BreadcrumbLink></BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>Negociação Paralela</BreadcrumbPage></BreadcrumbItem>
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

      <Card className="border-status-info/30 bg-status-info/5">
        <CardContent className="flex items-start gap-3 py-4">
          <Info className="h-5 w-5 text-status-info mt-0.5 shrink-0" />
          <p className="text-sm text-foreground/90 leading-relaxed">
            Os itens onde negociar um desconto com a Sayerlack rende mais dinheiro líquido — já descontando o
            custo do capital que fica parado em estoque. Ajuste o desconto que você espera e veja quanto prometer.
          </p>
        </CardContent>
      </Card>

      {/* Top 3 oportunidades */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Onde negociar este mês</h2>
          <p className="text-xs text-muted-foreground">Top 3 por dinheiro líquido (Sayerlack · OBEN).</p>
        </div>
        {loadingFila ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Calculando...
          </div>
        ) : fila.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-12 text-center gap-3">
            <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Nenhum candidato elegível (sem preço de compra/CMC).</p>
          </CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {fila.map(({ candidato }) => (
              <OportunidadeCard
                key={candidato.sku_codigo_omie}
                candidato={candidato}
                descontoPerc={Math.round(descontoDe(candidato.sku_codigo_omie) * 100) || DESCONTO_PADRAO * 100}
                onSetDesconto={(sku, perc) => setDesconto(sku, perc / 100)}
                onVouNegociar={handleVouNegociar}
              />
            ))}
          </div>
        )}
      </section>

      {/* Em andamento */}
      <section className="space-y-4 pt-2">
        <div>
          <h2 className="text-lg font-semibold">Em andamento</h2>
          <p className="text-xs text-muted-foreground">Negociações que você decidiu perseguir.</p>
        </div>
        {loadingAndamento ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
          </div>
        ) : emAndamento.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma negociação em andamento.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {emAndamento.map((s) => (
              <SugestaoCard
                key={s.id}
                s={s}
                rankingExtra={undefined}
                onMarcarVisualizada={() => {}}
                onIrAoRanking={() => {}}
                onMarcarEmAndamento={() => {}}
                onIgnorar={() => {}}
                onFecharSemAcordo={(sug) => setFecharSemAcordoTarget(sug)}
                onConverter={openConvertDialog}
              />
            ))}
          </div>
        )}
      </section>

      <FecharSemAcordoDialog
        open={!!fecharSemAcordoTarget}
        onOpenChange={(o) => { if (!o) { setFecharSemAcordoTarget(null); setFecharObs(""); } }}
        obs={fecharObs}
        onObsChange={setFecharObs}
        onCancel={() => setFecharSemAcordoTarget(null)}
        onConfirm={handleFecharSemAcordoConfirm}
      />
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
