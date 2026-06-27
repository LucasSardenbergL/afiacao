import { useNavigate } from "react-router-dom";
import { ArrowRight, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { REPOSICAO_STEPS } from "./ProcessoComprasStepper";
import { useReposicaoStatus, getStepLocks, type ReposicaoStatus } from "@/hooks/useReposicaoSessao";
import { Skeleton } from "@/components/ui/skeleton";

function describe(step: number, s: ReposicaoStatus): string {
  switch (step) {
    case 1:
      if (s.oportunidadesCount === null) return "Oportunidades indisponíveis";
      return s.oportunidadesCount > 0
        ? `${s.oportunidadesCount} oportunidade(s) ativa(s)`
        : "Sem oportunidades pendentes";
    case 2:
      return "Ajustados automaticamente";
    case 3:
      if (s.pedidosTotal === 0) return "Nenhum pedido gerado";
      return s.pedidosPendentes > 0
        ? `${s.pedidosPendentes} pedido(s) aguardando revisão`
        : `${s.pedidosTotal} pedido(s) revisado(s)`;
    case 4:
      return s.pedidosAprovados > 0
        ? `${s.pedidosAprovados} aprovado(s) prontos para Omie`
        : "Nada para aplicar";
    case 5:
      return s.pedidosTotal > 0
        ? `${s.pedidosDisparados}/${s.pedidosTotal} disparado(s)`
        : "Aguardando geração";
    default:
      return "";
  }
}

export function EtapasGrid() {
  const navigate = useNavigate();
  const { data: status, isLoading } = useReposicaoStatus();
  const locks = getStepLocks(status);
  const currentStep = status?.current ?? 3;

  if (isLoading || !status) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {REPOSICAO_STEPS.map((step, idx) => {
        const stepNum = idx + 1;
        const isCurrent = stepNum === currentStep;
        const isDone = stepNum < currentStep;
        const lock = locks[idx];
        const isLocked = !isCurrent && !isDone && lock.locked;
        const Icon = step.icon;

        return (
          <button
            key={step.label}
            type="button"
            onClick={() => navigate(step.to)}
            className={cn(
              "text-left transition-colors rounded-lg group",
              isLocked && "cursor-not-allowed",
            )}
          >
            <Card
              className={cn(
                "h-full transition-colors",
                isCurrent && "border-primary/40 bg-primary/5",
                isDone && "border-status-success/30 bg-status-success/5",
                isLocked && "border-dashed opacity-70",
                !isCurrent && !isDone && !isLocked && "hover:bg-muted/40",
              )}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
                        isCurrent && "bg-primary text-primary-foreground",
                        isDone && "bg-status-success text-white",
                        !isCurrent && !isDone && "bg-muted text-foreground/70",
                      )}
                    >
                      {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Icon className="h-4 w-4" />}
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Etapa {stepNum}
                    </span>
                  </div>
                  {isCurrent && (
                    <Badge className="h-4 px-1.5 text-[9px] bg-primary text-primary-foreground border-0">
                      atual
                    </Badge>
                  )}
                  {isDone && (
                    <Badge className="h-4 px-1.5 text-[9px] bg-status-success text-white border-0">
                      ok
                    </Badge>
                  )}
                </div>
                <div className="text-sm font-semibold mb-1">{step.label}</div>
                <div className="text-xs text-muted-foreground line-clamp-2">
                  {isLocked && lock.reason ? lock.reason : describe(stepNum, status)}
                </div>
                <div className="mt-3 text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                  Abrir etapa <ArrowRight className="h-3 w-3" />
                </div>
              </CardContent>
            </Card>
          </button>
        );
      })}
    </div>
  );
}

