import { useLocation, useNavigate } from "react-router-dom";
import {
  Lightbulb,
  SlidersHorizontal,
  ClipboardCheck,
  Upload,
  CheckCircle2,
  ChevronRight,
  Check,
  Lock,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { StepLock } from "@/hooks/useReposicaoSessao";

type Step = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  to: string;
  description?: string;
};

export const REPOSICAO_STEPS: Step[] = [
  { label: "Mercado", icon: Lightbulb, to: "/admin/reposicao/sessao/mercado" },
  { label: "Parâmetros", icon: SlidersHorizontal, to: "/admin/reposicao/sessao/parametros" },
  { label: "Pedidos", icon: ClipboardCheck, to: "/admin/reposicao/sessao/pedidos" },
  { label: "Aplicação Omie", icon: Upload, to: "/admin/reposicao/sessao/aplicacao" },
  { label: "Confirmação", icon: CheckCircle2, to: "/admin/reposicao/sessao/confirmacao" },
];

interface Props {
  currentStep?: number;
  onStepClick?: (step: number) => void;
  isLoading?: boolean;
  locks?: StepLock[];
}

export function ProcessoComprasStepper({
  currentStep = 3,
  onStepClick,
  isLoading = false,
  locks,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {REPOSICAO_STEPS.map((_, idx) => (
            <div key={idx} className="flex items-center flex-1 min-w-0 gap-2">
              <Skeleton className="h-14 w-full rounded-md" />
              {idx < REPOSICAO_STEPS.length - 1 && (
                <ChevronRight className="hidden sm:block h-4 w-4 text-muted-foreground shrink-0" />
              )}
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Card className="p-4">
        <ol className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-0">
          {REPOSICAO_STEPS.map((step, idx) => {
            const stepNum = idx + 1;
            const isCurrent = stepNum === currentStep;
            const isDone = stepNum < currentStep;
            const isFuture = stepNum > currentStep;
            const lock = locks?.[idx];
            const isLocked = !isCurrent && !isDone && !!lock?.locked;
            const Icon = step.icon;

            const handleClick = () => {
              if (onStepClick) {
                onStepClick(stepNum);
                return;
              }
              const targetPath = step.to.split("?")[0];
              const samePage = location.pathname === targetPath;
              navigate(step.to, { replace: samePage });
            };

            const button = (
              <button
                type="button"
                onClick={handleClick}
                aria-current={isCurrent ? "step" : undefined}
                aria-disabled={isLocked ? "true" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 w-full text-left transition-colors",
                  isCurrent && "bg-primary/10 text-primary border border-primary/30",
                  isDone && "bg-emerald-500/5 text-foreground border border-emerald-500/20",
                  isFuture && !isLocked && "bg-muted/40 text-muted-foreground border border-transparent",
                  isLocked && "bg-muted/30 text-muted-foreground/70 border border-dashed border-muted-foreground/20 opacity-70",
                  !isCurrent && !isLocked && "hover:bg-muted hover:text-foreground cursor-pointer",
                  isLocked && "cursor-not-allowed",
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    isCurrent && "bg-primary text-primary-foreground",
                    isDone && "bg-emerald-500 text-white",
                    isFuture && !isLocked && "bg-muted text-foreground/70",
                    isLocked && "bg-muted text-muted-foreground/60",
                  )}
                >
                  {isDone ? (
                    <Check className="h-4 w-4" />
                  ) : isLocked ? (
                    <Lock className="h-3.5 w-3.5" />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wide opacity-70">
                      Etapa {stepNum}
                    </span>
                    {isDone && (
                      <Badge className="h-4 px-1.5 text-[9px] bg-emerald-500 hover:bg-emerald-500 text-white border-0">
                        ok
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm font-medium truncate">{step.label}</div>
                </div>
              </button>
            );

            return (
              <li key={step.label} className="flex items-center flex-1 min-w-0">
                {isLocked && lock?.reason ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="w-full">{button}</span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      <p className="font-medium mb-1">Etapa bloqueada</p>
                      <p className="text-xs">{lock.reason}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  button
                )}
                {idx < REPOSICAO_STEPS.length - 1 && (
                  <ChevronRight className="hidden sm:block h-4 w-4 text-muted-foreground mx-1 shrink-0" />
                )}
              </li>
            );
          })}
        </ol>
      </Card>
    </TooltipProvider>
  );
}

