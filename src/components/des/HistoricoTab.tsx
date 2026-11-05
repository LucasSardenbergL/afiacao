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
import { temHistorico } from "./historico/derivar";
import { AvisoLeituraFalhou } from "@/components/leitura/AvisoLeituraFalhou";
import type { Props } from "./historico/types";

function HistoricoTabImpl({ empresa, ano: anoAtual, trimestre: trimestreAtual }: Props) {
  // Guarda a IDENTIDADE do trimestre, não uma cópia do card: o modal mostra sempre o card vigente
  // (após refetch, a cópia ficaria com meta/faturado velhos).
  const [detalhesChave, setDetalhesChave] = useState<{ ano: number; trimestre: number } | null>(null);

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
    estadoSemLeitura,
  } = useHistoricoData(empresa, anoAtual, trimestreAtual);

  // Leitura que não aconteceu (erro/offline) → aviso explícito, nunca "Nenhum trimestre
  // cadastrado" nem trimestres julgados com dado parcial. ANTES do skeleton: uma query ainda
  // carregando não pode esconder o erro de outra já conhecido.
  if (estadoSemLeitura) {
    return <AvisoLeituraFalhou oque="o histórico do DES" estado={estadoSemLeitura} variante="bloco" />;
  }

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (!temHistorico(cards)) {
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
          <QuarterCardItem
            key={`${c.ano}-${c.trimestre}`}
            card={c}
            onVerDetalhes={(x) => setDetalhesChave({ ano: x.ano, trimestre: x.trimestre })}
          />
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
      <DetalhesDialog
        detalhes={
          detalhesChave
            ? (cards.find((c) => c.ano === detalhesChave.ano && c.trimestre === detalhesChave.trimestre) ?? null)
            : null
        }
        onOpenChange={(o) => !o && setDetalhesChave(null)}
      />
    </div>
  );
}

export const HistoricoTab = memo(HistoricoTabImpl);
