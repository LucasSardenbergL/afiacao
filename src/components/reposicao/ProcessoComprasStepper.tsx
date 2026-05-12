import { useNavigate } from "react-router-dom";
import { Lightbulb, SlidersHorizontal, ClipboardCheck, Upload, Send, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Step = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  to?: string;
  description?: string;
};

interface Props {
  currentStep?: number;
}

export function ProcessoComprasStepper({ currentStep = 3 }: Props) {
  const navigate = useNavigate();

  const steps: Step[] = [
    { label: "Oportunidades", icon: Lightbulb, to: "/admin/reposicao/mercado" },
    { label: "Aprovar Parâmetros", icon: SlidersHorizontal, to: "/admin/reposicao/parametros" },
    { label: "Revisar Pedidos", icon: ClipboardCheck },
    { label: "Aplicar no Omie", icon: Upload, to: "/admin/reposicao/cockpit?tab=aplicar" },
    { label: "Confirmar Envio", icon: Send, description: "Aguarde o status Disparado" },
  ];

  return (
    <Card className="p-4">
      <ol className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-0">
        {steps.map((step, idx) => {
          const stepNum = idx + 1;
          const isCurrent = stepNum === currentStep;
          const Icon = step.icon;
          const clickable = !!step.to;

          return (
            <li key={step.label} className="flex items-center flex-1 min-w-0">
              <button
                type="button"
                disabled={!clickable}
                onClick={() => step.to && navigate(step.to)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 w-full text-left transition-colors",
                  isCurrent
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "bg-muted/40 text-muted-foreground border border-transparent",
                  clickable && !isCurrent && "hover:bg-muted hover:text-foreground cursor-pointer",
                  !clickable && !isCurrent && "cursor-default",
                )}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    isCurrent
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground/70",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wide opacity-70">
                      Etapa {stepNum}
                    </span>
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
