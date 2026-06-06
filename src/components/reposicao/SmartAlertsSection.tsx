import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bell, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { REPOSICAO_EMPRESA } from "@/hooks/useReposicaoSessao";

type SmartAlert = {
  id: string;
  level: "yellow" | "orange" | "red";
  message: string;
  actionLabel: string;
  onAction: () => void;
};

function useSmartAlerts(): SmartAlert[] {
  const navigate = useNavigate();

  // Alerta de "parâmetros aguardando aprovação" foi aposentado junto com a aprovação
  // manual (o motor/auto-apply ignoram aprovado_em; o alerta nunca resolveria).

  const { data: skusSemParam = 0 } = useQuery({
    queryKey: ["cockpit-alert-sem-parametro", REPOSICAO_EMPRESA],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("sku_parametros")
        .select("*", { count: "exact", head: true })
        .eq("empresa", REPOSICAO_EMPRESA)
        .eq("ativo", true)
        .is("estoque_minimo", null);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });

  return useMemo(() => {
    const list: SmartAlert[] = [];
    if (skusSemParam > 0) {
      list.push({
        id: "skus-sem-param",
        level: "red",
        message: `${skusSemParam} SKU(s) ativos sem parâmetro configurado`,
        actionLabel: "Configurar",
        onAction: () => navigate("/admin/reposicao/sessao/parametros"),
      });
    }
    return list;
  }, [skusSemParam, navigate]);
}

export function SmartAlertsSection() {
  const alerts = useSmartAlerts();
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem("cockpit-dismissed-alerts");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    try {
      sessionStorage.setItem("cockpit-dismissed-alerts", JSON.stringify(Array.from(next)));
    } catch {
      /* ignore */
    }
  };

  const visible = alerts.filter((a) => !dismissed.has(a.id)).slice(0, 3);
  if (visible.length === 0) return null;

  const tone = (l: SmartAlert["level"]) =>
    l === "yellow"
      ? "border-status-warning/40 bg-status-warning-bg text-status-warning-fg"
      : l === "orange"
        ? "border-status-warning-bold/40 bg-status-warning-bold/5 text-status-warning-bold"
        : "border-destructive/40 bg-destructive/5 text-destructive";

  const Icon = ({ l }: { l: SmartAlert["level"] }) =>
    l === "red" ? (
      <AlertTriangle className="h-4 w-4 shrink-0" />
    ) : l === "orange" ? (
      <Bell className="h-4 w-4 shrink-0" />
    ) : (
      <AlertTriangle className="h-4 w-4 shrink-0" />
    );

  return (
    <div className="space-y-2">
      {visible.map((a) => (
        <div
          key={a.id}
          className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${tone(a.level)}`}
        >
          <Icon l={a.level} />
          <span className="flex-1">{a.message}</span>
          <Button size="sm" variant="outline" onClick={a.onAction}>
            {a.actionLabel}
          </Button>
          <button
            type="button"
            onClick={() => dismiss(a.id)}
            className="opacity-60 hover:opacity-100"
            aria-label="Dispensar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

