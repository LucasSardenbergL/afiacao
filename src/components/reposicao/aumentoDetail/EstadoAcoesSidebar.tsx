// Sidebar "Estado e ações" do detalhe de aumento.
// Extraído de src/pages/AdminReposicaoAumentoDetail.tsx (god-component split).
// Presentational: recebe contadores/estado já calculados + callbacks de transição.
import { CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CancelarButton } from "./CancelarButton";
import { ESTADOS_LABEL, estadoBadgeClass } from "./shared";

export function EstadoAcoesSidebar({
  isNew,
  estadoAtual,
  itensAtivos,
  itensConfirmados,
  itensSemMapeamento,
  skusAfetadosCount,
  diasParaVigencia,
  diasEmVigencia,
  podeAtivar,
  updating,
  onAtivar,
  onCancelar,
  onExpirar,
}: {
  isNew: boolean;
  estadoAtual: string;
  itensAtivos: number;
  itensConfirmados: number;
  itensSemMapeamento: number;
  skusAfetadosCount: number;
  diasParaVigencia: number | null;
  diasEmVigencia: number | null;
  podeAtivar: boolean;
  updating: boolean;
  onAtivar: () => void;
  onCancelar: () => void;
  onExpirar: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Estado e ações</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Badge
            variant="outline"
            className={`text-base px-3 py-1 ${estadoBadgeClass(estadoAtual)}`}
          >
            {ESTADOS_LABEL[estadoAtual] ?? estadoAtual}
          </Badge>
        </div>

        {!isNew && (
          <>
            <div className="text-sm space-y-1 border-t pt-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Categorias ativas</span>
                <span className="font-medium tabular-nums">{itensAtivos}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Confirmadas</span>
                <span className="font-medium tabular-nums">{itensConfirmados}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sem mapeamento</span>
                <span
                  className={`font-medium tabular-nums ${
                    itensSemMapeamento > 0 ? "text-status-warning" : ""
                  }`}
                >
                  {itensSemMapeamento}
                </span>
              </div>
              <div className="flex justify-between border-t pt-2 mt-2">
                <span className="text-muted-foreground">SKUs afetados</span>
                <Badge variant="outline" className="tabular-nums">
                  {skusAfetadosCount}
                </Badge>
              </div>
            </div>

            {diasParaVigencia !== null && (
              <p className="text-xs text-muted-foreground italic">
                {diasParaVigencia >= 0
                  ? `Entra em vigência em ${diasParaVigencia} dia${diasParaVigencia === 1 ? "" : "s"}`
                  : `Vigência iniciada há ${-diasParaVigencia} dia${-diasParaVigencia === 1 ? "" : "s"}`}
              </p>
            )}
            {diasEmVigencia !== null && diasEmVigencia >= 0 && (
              <p className="text-xs text-muted-foreground italic">
                Em vigência há {diasEmVigencia} dia{diasEmVigencia === 1 ? "" : "s"}
              </p>
            )}

            <div className="space-y-2 border-t pt-3">
              {estadoAtual === "rascunho" && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block">
                        <Button
                          className="w-full"
                          disabled={!podeAtivar || updating}
                          onClick={onAtivar}
                        >
                          <CheckCircle2 className="h-4 w-4" /> Ativar anúncio
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!podeAtivar && (
                      <TooltipContent>
                        {itensAtivos === 0
                          ? "Adicione ao menos uma categoria"
                          : itensConfirmados < itensAtivos
                            ? "Confirme todas as categorias"
                            : "Mapeie ao menos uma família"}
                      </TooltipContent>
                    )}
                  </Tooltip>
                  <CancelarButton onConfirm={onCancelar} />
                </>
              )}
              {estadoAtual === "ativo" && <CancelarButton onConfirm={onCancelar} />}
              {estadoAtual === "vigente" && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={onExpirar}
                  disabled={updating}
                >
                  Marcar como expirado
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
