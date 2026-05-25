import { Outlet, useLocation } from "react-router-dom";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarRange } from "lucide-react";
import { ProcessoComprasStepper, REPOSICAO_STEPS } from "./ProcessoComprasStepper";
import { useReposicaoStatus, getStepLocks, deriveActiveStep } from "@/hooks/useReposicaoSessao";

const CUTOFF = "09:30";

export default function ReposicaoSessionLayout() {
  const location = useLocation();
  const { data: status, isLoading } = useReposicaoStatus();
  const progressStep = status?.current ?? 3;
  const activeStep = deriveActiveStep(location.pathname);
  // No cockpit index (/admin/reposicao/sessao) não há página de etapa, então
  // activeStep=0. Aí destacamos o PROGRESSO (dados) pra não ficar um stepper sem
  // nada marcado enquanto o ContinuarBanner diz "você está na etapa X".
  const isSessionIndex =
    location.pathname.replace(/\/+$/, "") === "/admin/reposicao/sessao";
  const stepperActiveStep = activeStep || (isSessionIndex ? progressStep : 0);
  const locks = getStepLocks(status);
  const today = format(new Date(), "EEEE, dd/MM/yyyy", { locale: ptBR });
  // label da etapa exibida (foco, ou progresso no index)
  const labelStep = stepperActiveStep || progressStep;
  const stepLabel = REPOSICAO_STEPS[Math.min(Math.max(labelStep, 1), REPOSICAO_STEPS.length) - 1]?.label;

  return (
    <div className="container mx-auto px-4 sm:px-6 pt-4 sm:pt-6 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarRange className="h-4 w-4" />
          <span className="font-medium text-foreground capitalize">{today}</span>
          <span aria-hidden>·</span>
          <span>cutoff {CUTOFF}</span>
          {!isLoading && stepLabel && (
            <>
              <span aria-hidden>·</span>
              <span>
                {activeStep ? "vendo etapa" : "etapa atual"}{" "}
                <span className="text-foreground font-medium">{labelStep}. {stepLabel}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <ProcessoComprasStepper
        activeStep={stepperActiveStep}
        progressStep={progressStep}
        isLoading={isLoading}
        locks={locks}
      />
      <div className="mt-6 pb-24">
        <Outlet />
      </div>
    </div>
  );
}
