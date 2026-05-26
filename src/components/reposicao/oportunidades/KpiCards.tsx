// Grid de 4 KPIs da página de Oportunidades.
// Extraído de src/pages/AdminReposicaoOportunidades.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PlayCircle } from "lucide-react";
import { formatBRL, formatDateLong, diasBadge } from "./shared";

export function KpiCards({
  totalEconomia, ganhoLiquidoPotencial, oportunidadesCount, totalSkusAtivos, dataLimiteMaisProxima, diasAteLimite, cicloHoje, onGerarCiclo,
}: {
  totalEconomia: number;
  ganhoLiquidoPotencial: number;
  oportunidadesCount: number;
  totalSkusAtivos: number;
  dataLimiteMaisProxima: string | null;
  diasAteLimite: number | null;
  cicloHoje: number;
  onGerarCiclo: () => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Ganho líquido potencial
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className={`text-2xl font-bold tabular-nums ${
              ganhoLiquidoPotencial > 0 ? "text-status-success" : "text-muted-foreground"
            }`}
          >
            {formatBRL(ganhoLiquidoPotencial)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            net-R$ dos SKUs com "comprar mais"
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Economia total potencial hoje
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-status-success tabular-nums">
            {formatBRL(totalEconomia)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            economia bruta (promoções e aumentos vigentes)
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            SKUs com oportunidade
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">
            {oportunidadesCount}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            de {totalSkusAtivos} SKUs ativos
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Data limite mais próxima
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dataLimiteMaisProxima ? (
            <>
              <div className="text-lg font-bold tabular-nums">
                {formatDateLong(dataLimiteMaisProxima)}
              </div>
              <div className="mt-1">
                <Badge variant="outline" className={diasBadge(diasAteLimite)}>
                  em {diasAteLimite} {diasAteLimite === 1 ? "dia" : "dias"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Próxima janela crítica
              </p>
            </>
          ) : (
            <>
              <div className="text-lg font-bold text-muted-foreground">—</div>
              <p className="text-xs text-muted-foreground mt-1">
                Sem janelas ativas
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Ciclo oportunidade do dia
          </CardTitle>
        </CardHeader>
        <CardContent>
          {cicloHoje > 0 ? (
            <>
              <Badge
                className="bg-status-success/15 text-status-success border-status-success/30 cursor-pointer hover:bg-status-success/25"
                variant="outline"
                onClick={onGerarCiclo}
              >
                <PlayCircle className="h-3 w-3 mr-1" />
                Gerar ciclo oportunidade
              </Badge>
              <p className="text-xs text-muted-foreground mt-2">
                {cicloHoje} {cicloHoje === 1 ? "evento" : "eventos"} encerra(m) hoje
              </p>
            </>
          ) : (
            <>
              <Badge variant="outline" className="text-muted-foreground">
                Sem ciclo hoje
              </Badge>
              <p className="text-xs text-muted-foreground mt-2">
                Próxima janela crítica ainda não chegou
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
