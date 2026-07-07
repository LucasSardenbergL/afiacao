import { Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { type Props } from "./checkinQualitativo/types";
import { useCheckinQualitativo } from "./checkinQualitativo/useCheckinQualitativo";
import { DescontoProjetadoCard } from "./checkinQualitativo/DescontoProjetadoCard";
import { CriterioCard } from "./checkinQualitativo/CriterioCard";
import { HistoricoCheckins } from "./checkinQualitativo/HistoricoCheckins";
import { ConfirmacaoAndreDialog } from "./checkinQualitativo/ConfirmacaoAndreDialog";

export function CheckinQualitativoTab({ empresa, ano, trimestre }: Props) {
  const {
    respostas,
    setResposta,
    saving,
    confirmAndreOpen,
    setConfirmAndreOpen,
    percentualPorCriterio,
    desconto,
    max,
    total,
    cardColor,
    totalColor,
    salvarCheckin,
    isLoading,
    qualitativos,
    bonusItems,
    historicoLoading,
    historico,
  } = useCheckinQualitativo({ empresa, ano, trimestre });

  return (
    <div className="space-y-6">
      {/* Topo: card de desconto projetado */}
      <DescontoProjetadoCard
        desconto={desconto}
        max={max}
        total={total}
        cardColor={cardColor}
        totalColor={totalColor}
        saving={saving}
        isLoading={isLoading}
        onSalvarProjecao={() => salvarCheckin("projecao")}
        onSalvarConfirmacao={() => setConfirmAndreOpen(true)}
      />

      {/* Critérios */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {qualitativos.map((c) => (
              <CriterioCard
                key={c.id}
                criterio={c}
                resposta={respostas[c.id] ?? { atingido: false, observacao: "" }}
                percentual={percentualPorCriterio[c.id] ?? 0}
                onChange={(resp) => setResposta(c.id, resp)}
              />
            ))}
          </div>

          {bonusItems.length > 0 && (
            <>
              <div className="flex items-center gap-3 pt-2">
                <Sparkles className="h-4 w-4 text-status-warning" />
                <span className="text-sm font-semibold text-foreground">Bônus extra</span>
                <Separator className="flex-1" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {bonusItems.map((c) => (
                  <CriterioCard
                    key={c.id}
                    criterio={c}
                    resposta={respostas[c.id] ?? { atingido: false, observacao: "" }}
                    percentual={percentualPorCriterio[c.id] ?? 0}
                    bonus
                    onChange={(resp) => setResposta(c.id, resp)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Histórico do trimestre */}
      <HistoricoCheckins loading={historicoLoading} historico={historico} />

      {/* Dialog confirmação com André */}
      <ConfirmacaoAndreDialog
        open={confirmAndreOpen}
        onOpenChange={setConfirmAndreOpen}
        saving={saving}
        onConfirm={() => salvarCheckin("confirmacao_andre")}
      />
    </div>
  );
}
