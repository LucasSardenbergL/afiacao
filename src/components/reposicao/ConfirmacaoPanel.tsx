import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  CheckCircle2,
  Clock,
  DollarSign,
  Package,
  Send,
  Truck,
  ScrollText,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { REPOSICAO_EMPRESA } from "@/hooks/useReposicaoSessao";

const formatBRL = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

type PedidoRow = {
  status: string | null;
  fornecedor_nome: string | null;
  num_skus: number | null;
  valor_total: number | null;
};

type AuditRow = {
  id: string;
  action: string;
  result: string;
  created_at: string;
};

function useResumoCiclo() {
  const today = format(new Date(), "yyyy-MM-dd");
  return useQuery({
    queryKey: ["confirmacao-resumo-ciclo", REPOSICAO_EMPRESA, today],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pedido_compra_sugerido")
        .select("status,fornecedor_nome,num_skus,valor_total")
        .eq("empresa", REPOSICAO_EMPRESA)
        .eq("data_ciclo", today);
      if (error) throw error;
      const rows = ((data ?? []) as unknown) as PedidoRow[];

      const fornecedores = new Set<string>();
      let totalSkus = 0;
      let totalValor = 0;
      let disparados = 0;
      let aprovados = 0;
      let pendentes = 0;
      let bloqueados = 0;

      for (const r of rows) {
        if (r.fornecedor_nome) fornecedores.add(r.fornecedor_nome);
        totalSkus += Number(r.num_skus ?? 0);
        totalValor += Number(r.valor_total ?? 0);
        if (r.status === "disparado") disparados++;
        else if (r.status === "aprovado_aguardando_disparo") aprovados++;
        else if (r.status === "pendente_aprovacao") pendentes++;
        else if (r.status === "bloqueado_guardrail") bloqueados++;
      }

      return {
        total: rows.length,
        fornecedores: fornecedores.size,
        totalSkus,
        totalValor,
        disparados,
        aprovados,
        pendentes,
        bloqueados,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function useTimelineCiclo() {
  const todayStart = startOfDay(new Date()).toISOString();
  return useQuery({
    queryKey: ["confirmacao-timeline", todayStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cockpit_audit_log")
        .select("id,action,result,created_at")
        .gte("created_at", todayStart)
        .order("created_at", { ascending: true })
        .limit(50);
      if (error) throw error;
      return ((data ?? []) as unknown) as AuditRow[];
    },
    staleTime: 30_000,
  });
}

export function ConfirmacaoPanel() {
  const navigate = useNavigate();
  const { data: resumo, isLoading: loadingResumo } = useResumoCiclo();
  const { data: timeline = [], isLoading: loadingTimeline } = useTimelineCiclo();

  const concluido = resumo
    ? resumo.total > 0 &&
      resumo.pendentes === 0 &&
      resumo.aprovados === 0 &&
      resumo.bloqueados === 0
    : false;

  const semCiclo = !loadingResumo && resumo && resumo.total === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {concluido ? (
                <CheckCircle2 className="h-5 w-5 text-status-success" />
              ) : (
                <Clock className="h-5 w-5 text-status-warning" />
              )}
              Resumo do ciclo de hoje
            </CardTitle>
            {!loadingResumo && resumo && resumo.total > 0 && (
              <Badge
                variant="outline"
                className={
                  concluido
                    ? "border-status-success/40 bg-status-success/10 text-status-success"
                    : "border-status-warning/40 bg-status-warning/10 text-status-warning"
                }
              >
                {concluido ? "Ciclo concluído" : "Em andamento"}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loadingResumo ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : semCiclo ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <AlertTriangle className="h-4 w-4" />
              Nenhum pedido gerado para hoje ainda.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <ResumoCard
                  icon={<DollarSign className="h-4 w-4 text-primary" />}
                  label="Valor total"
                  value={formatBRL(resumo?.totalValor)}
                />
                <ResumoCard
                  icon={<Package className="h-4 w-4 text-primary" />}
                  label="SKUs"
                  value={String(resumo?.totalSkus ?? 0)}
                />
                <ResumoCard
                  icon={<Truck className="h-4 w-4 text-primary" />}
                  label="Fornecedores"
                  value={String(resumo?.fornecedores ?? 0)}
                />
                <ResumoCard
                  icon={<Send className="h-4 w-4 text-primary" />}
                  label="Disparados"
                  value={`${resumo?.disparados ?? 0}/${resumo?.total ?? 0}`}
                />
              </div>

              {resumo && (resumo.pendentes > 0 || resumo.bloqueados > 0 || resumo.aprovados > 0) && (
                <div className="mt-4 flex items-center gap-2 flex-wrap text-xs">
                  {resumo.pendentes > 0 && (
                    <Badge variant="outline" className="border-status-warning/40 bg-status-warning-bg text-status-warning">
                      {resumo.pendentes} pendente{resumo.pendentes > 1 ? "s" : ""} de aprovação
                    </Badge>
                  )}
                  {resumo.aprovados > 0 && (
                    <Badge variant="outline" className="border-status-info/40 bg-status-info-bg text-status-info">
                      {resumo.aprovados} aguardando disparo
                    </Badge>
                  )}
                  {resumo.bloqueados > 0 && (
                    <Badge variant="outline" className="border-status-error/40 bg-status-error-bg text-status-error">
                      {resumo.bloqueados} bloqueado{resumo.bloqueados > 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-5 w-5 text-muted-foreground" />
            Linha do tempo do ciclo
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("/admin/reposicao/historico")}
          >
            Ver histórico completo
            <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </CardHeader>
        <CardContent>
          {loadingTimeline ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : timeline.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4">
              Nada registrado ainda hoje.
            </div>
          ) : (
            <ol className="relative border-l border-muted ml-2 space-y-3">
              {timeline.map((ev) => (
                <li key={ev.id} className="pl-4 relative">
                  <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-mono text-muted-foreground tabular-nums">
                      {format(new Date(ev.created_at), "HH:mm", { locale: ptBR })}
                    </span>
                    <span className="text-sm font-medium">{ev.action}</span>
                    <span className="text-xs text-muted-foreground">— {ev.result}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ResumoCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-lg font-semibold mt-1 truncate">{value}</div>
    </div>
  );
}

