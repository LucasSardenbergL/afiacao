// Cabeçalho dos Alertas de Outlier: o que pede decisão (fila) separado do que é registro.
// Contagem por severidade saiu: misturava venda atípica (que ninguém precisa decidir) com o que pede
// ação, e o "Excluídos hoje" contava uma decisão que não existe mais (spec 2026-07-16).
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ROTA_REVISAO_PARAMETROS, type OutlierStats, type Visao } from "./types";

function Kpi({
  rotulo, valor, detalhe, ativo, onClick, tom,
}: {
  rotulo: string;
  valor: number | undefined;
  detalhe?: React.ReactNode;
  ativo?: boolean;
  onClick?: () => void;
  tom?: "acao";
}) {
  const conteudo = (
    <CardContent className="pt-4">
      <div className={cn("text-xs text-muted-foreground", tom === "acao" && "text-status-warning")}>{rotulo}</div>
      <div className="text-2xl font-bold tabular-nums">{valor ?? "—"}</div>
      {detalhe && <div className="text-xs text-muted-foreground mt-1">{detalhe}</div>}
    </CardContent>
  );
  return (
    <Card className={cn(ativo && "border-primary/60", tom === "acao" && (valor ?? 0) > 0 && "border-status-warning/40")}>
      {onClick ? (
        <button type="button" onClick={onClick} className="w-full text-left" aria-pressed={ativo}>
          {conteudo}
        </button>
      ) : (
        conteudo
      )}
    </Card>
  );
}

export function StatsCards({
  stats, visao, onVisao,
}: {
  stats?: OutlierStats;
  visao: Visao;
  onVisao: (v: Visao) => void;
}) {
  const fila = stats ? stats.semGrupo + stats.ltAtipico : undefined;
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Kpi
        rotulo="Fila de ação"
        valor={fila}
        tom="acao"
        ativo={visao === "fila"}
        onClick={() => onVisao("fila")}
        detalhe={stats ? `${stats.semGrupo} sem grupo · ${stats.ltAtipico} LT atípico` : undefined}
      />
      <Kpi
        rotulo="LT atípico crítico"
        valor={stats?.ltCriticos}
        detalhe="cobrar fornecedor"
      />
      <Kpi
        rotulo="Registro: venda atípica"
        valor={stats?.vendaAtipica}
        ativo={visao === "registro"}
        onClick={() => onVisao("registro")}
        detalhe="informativo — não muda o motor"
      />
      <Kpi
        rotulo="Omie: inativado / reativado"
        valor={stats ? stats.inativadoOmie + stats.reativadoOmie : undefined}
        detalhe={
          stats && stats.reativadoOmie > 0 ? (
            <Link to={ROTA_REVISAO_PARAMETROS} className="underline underline-offset-2 hover:text-foreground">
              {stats.reativadoOmie} reativado(s) para religar
            </Link>
          ) : (
            "inativado fecha sozinho ao reativar"
          )
        }
      />
      <Kpi rotulo="Decididos hoje" valor={stats?.decididosHoje} />
    </div>
  );
}
