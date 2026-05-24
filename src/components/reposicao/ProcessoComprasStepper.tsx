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
import { REPOSICAO_STEP_PATHS, type StepLock } from "@/hooks/useReposicaoSessao";

type Step = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  to: string;
  description?: string;
};

const STEP_META: { label: string; icon: Step["icon"] }[] = [
  { label: "Mercado", icon: Lightbulb },
  { label: "Parâmetros", icon: SlidersHorizontal },
  { label: "Pedidos", icon: ClipboardCheck },
  { label: "Aplicação Omie", icon: Upload },
  { label: "Confirmação", icon: CheckCircle2 },
];

export const REPOSICAO_STEPS: Step[] = STEP_META.map((m, i) => ({
  label: m.label,
  icon: m.icon,
  to: REPOSICAO_STEP_PATHS[i],
}));

interface Props {
  /** Etapa em FOCO (1-based), derivada da URL. 0 = nenhuma (ex.: cockpit index). */
  activeStep?: number;
  /** Etapa de PROGRESSO (1-based), derivada dos dados (deriveCurrentStep). */
  progressStep?: number;
  onStepClick?: (step: number) => void;
  isLoading?: boolean;
  locks?: StepLock[];
}

export function ProcessoComprasStepper({
  activeStep = 0,
  progressStep = 3,
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
            const isActive = stepNum === activeStep;       // etapa em FOCO (URL)
            const isProgress = stepNum === progressStep;   // etapa de PROGRESSO (dados)
            const isDone = stepNum < progressStep;         // concluída (independe do foco)
            const isFuture = stepNum > progressStep;       // futura (independe do foco)
            const lock = locks?.[idx];
            const isLocked = !isActive && !!lock?.locked;  // nunca trava a etapa em foco
            const Icon = step.icon;

            const handleClick = () => {
              if (isLocked) return; // bloqueio real, comportamental
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
                aria-current={isActive ? "step" : undefined}
                aria-disabled={isLocked ? "true" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 w-full text-left transition-colors",
                  isActive && "bg-primary/10 text-primary border border-primary/30",
                  !isActive && isProgress && "border border-primary/20",
                  !isActive && isDone && "bg-status-success/5 text-foreground border border-status-success/20",
                  !isActive && isFuture && !isLocked && "bg-muted/40 text-muted-foreground border border-transparent",
                  isLocked && "bg-muted/30 text-muted-foreground/70 border border-dashed border-muted-foreground/20 opacity-70",
                  !isActive && !isLocked && "hover:bg-muted hover:text-foreground cursor-pointer",
                  isLocked && "cursor-not-allowed",
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    isActive && "bg-primary text-primary-foreground",
                    isDone && "bg-status-success text-white",
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
                      <Badge className="h-4 px-1.5 text-[9px] bg-status-success hover:bg-status-success text-white border-0">
                        ok
                      </Badge>
                    )}
                    {isProgress && !isActive && (
                      <Badge
                        variant="outline"
                        className="h-4 px-1.5 text-[9px] border-primary/40 text-primary"
                      >
                        atual
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

