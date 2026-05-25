// Card de topo: desconto projetado para o próximo trimestre + ação Salvar.
// Extraído verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).
import { ChevronDown, Save, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { type DescontoCheckin } from "./types";
import { fmtPct } from "./format";

interface DescontoProjetadoCardProps {
  desconto: DescontoCheckin | null | undefined;
  max: number;
  total: number;
  cardColor: string;
  totalColor: string;
  saving: boolean;
  isLoading: boolean;
  onSalvarProjecao: () => void;
  onSalvarConfirmacao: () => void;
}

export function DescontoProjetadoCard({
  desconto,
  max,
  total,
  cardColor,
  totalColor,
  saving,
  isLoading,
  onSalvarProjecao,
  onSalvarConfirmacao,
}: DescontoProjetadoCardProps) {
  return (
    <Card className={cn("border-2", cardColor)}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
              Desconto projetado para o próximo trimestre
            </p>
            <p className={cn("text-3xl font-bold mt-2", totalColor)}>
              Se confirmar os critérios, será {fmtPct(total)}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Padrão da faixa: <strong>{fmtPct(desconto?.desconto_padrao)}</strong> + Qualitativos atingidos:{" "}
              <strong>{fmtPct(desconto?.qualitativos_atingidos_perc)}</strong> + Bônus:{" "}
              <strong>{fmtPct(desconto?.bonus_atingido_perc)}</strong>
            </p>
            {max > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                Máximo possível desta faixa: {fmtPct(max)}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={saving || isLoading}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Salvar
                  <ChevronDown className="h-4 w-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onSalvarProjecao}>
                  Salvar como Projeção
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onSalvarConfirmacao}>
                  Salvar como Confirmação (com André)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
