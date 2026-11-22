// Sidebar direita "Estado e ações" da tela de detalhe de campanha.
// Extraída de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  estadoBadgeClass,
} from "@/components/reposicao/promocaoDetail/helpers";
import { ESTADO_LABEL } from "@/components/reposicao/promocaoDetail/types";

type EstadoAcoesSidebarProps = {
  estado: string;
  isNew: boolean;
  itensAtivos: number;
  itensConfirmados: number;
  podeAtivar: boolean;
  podeCancelar: boolean;
  podeEncerrar: boolean;
  transitioning: boolean;
  onTransition: (novoEstado: string) => void;
  onOpenCancel: () => void;
};

export function EstadoAcoesSidebar({
  estado,
  isNew,
  itensAtivos,
  itensConfirmados,
  podeAtivar,
  podeCancelar,
  podeEncerrar,
  transitioning,
  onTransition,
  onOpenCancel,
}: EstadoAcoesSidebarProps) {
  return (
    <Card className="lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle className="text-base">Estado e ações</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-center">
          <Badge
            variant="outline"
            className={`${estadoBadgeClass(estado)} text-sm py-1.5 px-3`}
          >
            {ESTADO_LABEL[estado] || estado}
          </Badge>
        </div>

        {!isNew && (
          <div className="text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{itensAtivos}</span>{" "}
            {itensAtivos === 1 ? "item ativo" : "itens ativos"},{" "}
            <span className="font-medium text-foreground">
              {itensConfirmados}
            </span>{" "}
            confirmados
          </div>
        )}

        {!isNew && (
          <div className="space-y-2 pt-2 border-t">
            {(estado === "rascunho" || estado === "negociando") && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Button
                        className="w-full"
                        disabled={!podeAtivar || transitioning}
                        onClick={() => onTransition("ativa")}
                      >
                        <Check className="h-4 w-4" /> Ativar campanha
                      </Button>
                    </div>
                  </TooltipTrigger>
                  {!podeAtivar && (
                    <TooltipContent>
                      Confirme todos os itens antes de ativar
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            )}

            {podeEncerrar && (
              <Button
                className="w-full"
                variant="outline"
                onClick={() => onTransition("encerrada")}
                disabled={transitioning}
              >
                Encerrar agora
              </Button>
            )}

            {podeCancelar && (
              <Button
                className="w-full"
                variant="destructive"
                onClick={onOpenCancel}
                disabled={transitioning}
              >
                <X className="h-4 w-4" /> Cancelar campanha
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
