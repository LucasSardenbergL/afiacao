// Aba de histórico trimestral do DES (dashboard executivo).
// Composição: useHistoricoData (dados/filtros) + filtros + gráfico + timeline + modal.
// God-component split de src/components/des/HistoricoTab.tsx (comportamento 1:1).
import { memo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHistoricoData } from "./historico/useHistoricoData";
import { HistoricoFiltros } from "./historico/HistoricoFiltros";
import { FaturamentoChart } from "./historico/FaturamentoChart";
import { QuarterCardItem } from "./historico/QuarterCardItem";
import { DetalhesDialog } from "./historico/DetalhesDialog";
import type { Props, QuarterCard } from "./historico/types";

function HistoricoTabImpl({ empresa, ano: anoAtual, trimestre: trimestreAtual }: Props) {
  const [detalhesOpen, setDetalhesOpen] = useState<QuarterCard | null>(null);

  const {
    filtroAno,
    setFiltroAno,
    filtroStatus,
    setFiltroStatus,
    cards,
    anosDisponiveis,
    cardsFiltrados,
    chartData,
    metaMedia,
    isLoading,
  } = useHistoricoData(empresa, anoAtual, trimestreAtual);

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (!cards.length || (cards.length === 1 && cards[0].meta === 0 && !cards[0].ultimoCheckin && !cards[0].snapshots.length)) {
    return (
      <Card>
        <CardContent className="p-12 text-center space-y-3">
          <CalendarDays className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Nenhum trimestre cadastrado ainda.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/des/configuracao">Cadastrar meta trimestral</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <HistoricoFiltros
        filtroAno={filtroAno}
        onFiltroAnoChange={setFiltroAno}
        filtroStatus={filtroStatus}
        onFiltroStatusChange={setFiltroStatus}
        anosDisponiveis={anosDisponiveis}
      />

      {/* Gráfico */}
      {chartData.length > 0 && (
        <FaturamentoChart chartData={chartData} metaMedia={metaMedia} />
      )}

      {/* Timeline de cards */}
      <div className="space-y-4">
        {cardsFiltrados.map((c) => (
          <QuarterCardItem key={`${c.ano}-${c.trimestre}`} card={c} onVerDetalhes={setDetalhesOpen} />
        ))}
        {cardsFiltrados.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Nenhum trimestre corresponde aos filtros.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Modal de detalhes */}
      <DetalhesDialog detalhes={detalhesOpen} onOpenChange={(o) => !o && setDetalhesOpen(null)} />
    </div>
  );
}

export const HistoricoTab = memo(HistoricoTabImpl);
