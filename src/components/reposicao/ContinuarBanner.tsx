import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ArrowRight, History, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { REPOSICAO_STEPS } from "./ProcessoComprasStepper";

interface Props {
  currentStep: number;
}

export function ContinuarBanner({ currentStep }: Props) {
  const navigate = useNavigate();
  const todayStart = startOfDay(new Date()).toISOString();

  const { data: lastEvent } = useQuery({
    queryKey: ["cockpit-last-event-today", todayStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cockpit_audit_log")
        .select("action,result,created_at")
        .gte("created_at", todayStart)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      const rows = ((data ?? []) as unknown) as Array<{
        action: string;
        result: string;
        created_at: string;
      }>;
      return rows[0] ?? null;
    },
    staleTime: 30_000,
  });

  const step = REPOSICAO_STEPS[Math.min(Math.max(currentStep, 1), REPOSICAO_STEPS.length) - 1];
  const stepLabel = step?.label ?? "—";
  const stepRoute = step?.to;

  const handleContinuar = () => {
    if (stepRoute) navigate(stepRoute);
  };

  const hasHistory = !!lastEvent;
  const lastTime = lastEvent
    ? format(new Date(lastEvent.created_at), "HH:mm", { locale: ptBR })
    : null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {hasHistory ? (
            <History className="h-5 w-5 text-primary shrink-0" />
          ) : (
            <Sparkles className="h-5 w-5 text-primary shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {hasHistory
                ? `Última ação às ${lastTime} — ${lastEvent?.action}`
                : "Iniciar sessão de reposição"}
            </div>
            <div className="text-xs text-muted-foreground">
              Você está na <span className="font-medium text-foreground">etapa {currentStep}</span>:{" "}
              {stepLabel}
            </div>
          </div>
        </div>
        <Button size="sm" onClick={handleContinuar}>
          {hasHistory ? "Continuar" : "Começar"}
          <ArrowRight className="h-4 w-4 ml-1.5" />
        </Button>
      </CardContent>
    </Card>
  );
}

