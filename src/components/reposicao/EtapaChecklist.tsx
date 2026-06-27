import { CheckCircle2, Circle, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useReposicaoStatus, type ReposicaoStatus } from "@/hooks/useReposicaoSessao";
import { useNavigate } from "react-router-dom";

export type ChecklistItem = {
  label: string;
  done: boolean;
  cta?: { label: string; to: string };
};

export type ChecklistDef = {
  title: string;
  items: ChecklistItem[];
};

/** Pure builder — exported for unit testing. */
export function buildEtapaChecklist(step: number, s: ReposicaoStatus): ChecklistDef {
  switch (step) {
    case 1:
      return {
        title: "Para concluir a Etapa 1: Mercado",
        items: [
          {
            label:
              s.oportunidadesCount === null
                ? "Oportunidades econômicas (contagem indisponível)"
                : `Avaliar ${s.oportunidadesCount} oportunidade(s) econômica(s) ativa(s)`,
            done: s.oportunidadesCount === 0,
            cta:
              (s.oportunidadesCount ?? 0) > 0
                ? { label: "Abrir oportunidades", to: "/admin/reposicao/oportunidades" }
                : undefined,
          },
        ],
      };
    case 2:
      return {
        title: "Etapa 2: Parâmetros (automático)",
        items: [
          {
            // Aprovação manual aposentada — os parâmetros são ajustados todo dia.
            label: "Parâmetros ajustados automaticamente todo dia",
            done: true,
          },
        ],
      };
    case 3:
      return {
        title: "Para concluir a Etapa 3: Pedidos",
        items: [
          {
            label:
              s.pedidosTotal === 0
                ? "Gerar pedidos do ciclo de hoje"
                : `Revisar ${s.pedidosPendentes} pedido(s) pendente(s)`,
            done: s.pedidosTotal > 0 && s.pedidosPendentes === 0,
          },
          {
            label:
              s.pedidosBloqueados > 0
                ? `Resolver ${s.pedidosBloqueados} pedido(s) bloqueado(s) por guardrail`
                : "Sem bloqueios de guardrail",
            done: s.pedidosBloqueados === 0,
          },
        ],
      };
    case 4:
      return {
        title: "Para concluir a Etapa 4: Aplicação Omie",
        items: [
          {
            label: `Confirmar aplicação no Omie (${s.pedidosAprovados} aprovado(s) aguardando)`,
            done: s.pedidosAprovados === 0 && s.pedidosDisparados > 0,
          },
        ],
      };
    case 5:
      return {
        title: "Para concluir a Etapa 5: Confirmação",
        items: [
          {
            label: `${s.pedidosDisparados} de ${s.pedidosTotal} pedido(s) disparado(s)`,
            done: s.pedidosTotal > 0 && s.pedidosDisparados === s.pedidosTotal,
          },
        ],
      };
    default:
      return { title: "", items: [] };
  }
}

interface Props {
  step: 1 | 2 | 3 | 4 | 5;
}

export function EtapaChecklist({ step }: Props) {
  const navigate = useNavigate();
  const { data: status, isLoading } = useReposicaoStatus();

  if (isLoading || !status) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-5 w-48 mb-3" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  const def = buildEtapaChecklist(step, status);
  const allDone = def.items.every((i) => i.done);

  return (
    <Card className={cn(allDone && "border-status-success/30 bg-status-success/5")}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          {allDone ? (
            <CheckCircle2 className="h-4 w-4 text-status-success" />
          ) : (
            <Circle className="h-4 w-4 text-muted-foreground" />
          )}
          {def.title}
          {allDone && (
            <span className="text-xs font-normal text-status-success ml-auto">
              tudo pronto
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-1.5">
          {def.items.map((item, idx) => (
            <li key={idx} className="flex items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                {item.done ? (
                  <CheckCircle2 className="h-4 w-4 text-status-success shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className={cn("truncate", item.done && "text-muted-foreground")}>
                  {item.label}
                </span>
              </div>
              {item.cta && !item.done && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => navigate(item.cta!.to)}
                >
                  {item.cta.label}
                  <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

