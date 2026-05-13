import { useNavigate } from "react-router-dom";
import { Lightbulb, SlidersHorizontal, ClipboardCheck, Upload, Send, ChevronRight, Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Step = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  to?: string;
  description?: string;
};

interface Props {
  currentStep?: number;
  /** Optional click handler. When provided, overrides default navigation. */
  onStepClick?: (step: number) => void;
  /** When true, renders a skeleton placeholder instead of the stepper. */
  isLoading?: boolean;
}

export function ProcessoComprasStepper({ currentStep = 3, onStepClick, isLoading = false }: Props) {
  const navigate = useNavigate();

  const steps: Step[] = [
    { label: "Oportunidades", icon: Lightbulb, to: "/admin/reposicao/mercado" },
    { label: "Aprovar Parâmetros", icon: SlidersHorizontal, to: "/admin/reposicao/parametros" },
    { label: "Revisar Pedidos", icon: ClipboardCheck },
    { label: "Aplicar no Omie", icon: Upload, to: "/admin/reposicao/cockpit?tab=aplicaromie" },
    { label: "Confirmar Envio", icon: Send, description: "Aguarde o status Disparado" },
  ];

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {steps.map((_, idx) => (
            <div key={idx} className="flex items-center flex-1 min-w-0 gap-2">
              <Skeleton className="h-14 w-full rounded-md" />
              {idx < steps.length - 1 && (
                <ChevronRight className="hidden sm:block h-4 w-4 text-muted-foreground shrink-0" />
              )}
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <ol className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-0">
        {steps.map((step, idx) => {
          const stepNum = idx + 1;
          const isCurrent = stepNum === currentStep;
          const isDone = stepNum < currentStep;
          const isFuture = stepNum > currentStep;
          const Icon = step.icon;
          const clickable = !!onStepClick || !!step.to;

          const handleClick = () => {
            if (onStepClick) {
              onStepClick(stepNum);
            } else if (step.to) {
              navigate(step.to);
            }
          };

          return (
            <li key={step.label} className="flex items-center flex-1 min-w-0">
              <button
                type="button"
                disabled={!clickable}
                onClick={handleClick}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 w-full text-left transition-colors",
                  isCurrent && "bg-primary/10 text-primary border border-primary/30",
                  isDone && "bg-emerald-500/5 text-foreground border border-emerald-500/20",
                  isFuture && "bg-muted/40 text-muted-foreground border border-transparent",
                  clickable && !isCurrent && "hover:bg-muted hover:text-foreground cursor-pointer",
                  !clickable && !isCurrent && "cursor-default",
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    isCurrent && "bg-primary text-primary-foreground",
                    isDone && "bg-emerald-500 text-white",
                    isFuture && "bg-muted text-foreground/70",
                  )}
                >
                  {isDone ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wide opacity-70">
                      Etapa {stepNum}
                    </span>
                    {isDone && (
                      <Badge className="h-4 px-1.5 text-[9px] bg-emerald-500 hover:bg-emerald-500 text-white border-0">
                        Concluído
                      </Badge>
                    )}
                    {isCurrent && (
                      <Badge className="h-4 px-1.5 text-[9px] bg-primary hover:bg-primary text-primary-foreground border-0">
                        Etapa {stepNum}
                      </Badge>
                    )}
                    {isFuture && (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                        Pendente
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm font-medium truncate">{step.label}</div>
                  {step.description && (
                    <div className="text-xs text-muted-foreground truncate">
                      {step.description}
                    </div>
                  )}
                </div>
              </button>
              {idx < steps.length - 1 && (
                <ChevronRight className="hidden sm:block h-4 w-4 text-muted-foreground mx-1 shrink-0" />
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export default ProcessoComprasStepper;
