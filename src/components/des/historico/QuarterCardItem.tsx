// Card de um trimestre na timeline do HistoricoTab.
// Extraído verbatim de src/components/des/HistoricoTab.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtBRL, fmtPct, fmtDate } from "./format";
import { StarsRow } from "./StarsRow";
import type { QuarterCard } from "./types";

interface QuarterCardItemProps {
  card: QuarterCard;
  onVerDetalhes: (c: QuarterCard) => void;
}

export function QuarterCardItem({ card: c, onVerDetalhes }: QuarterCardItemProps) {
  const progress = c.meta > 0 ? Math.min((c.faturado / c.meta) * 100, 100) : 0;
  const atingiu = c.meta > 0 && c.faturado >= c.meta;
  return (
    <Card className={cn(c.isAtual && "border-status-info/40")}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-lg">T{c.trimestre} {c.ano}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              de {fmtDate(c.inicio)} a {fmtDate(c.fim)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {c.isAtual && (
              <Badge variant="outline" className="bg-status-info/10 border-status-info/40 text-status-info text-xs">
                Em andamento
              </Badge>
            )}
            {!c.isAtual && c.meta > 0 && (
              atingiu ? (
                <Badge variant="outline" className="bg-status-success/10 border-status-success/40 text-status-success text-xs">
                  Meta atingida
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-status-error/10 border-status-error/40 text-status-error text-xs">
                  Meta não atingida
                </Badge>
              )
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Meta pessoal</p>
            <p className="text-sm font-medium mt-1">{fmtBRL(c.meta)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {c.isAtual ? "Faturado (ao vivo)" : "Faturado final"}
            </p>
            <p className={cn("text-sm font-medium mt-1", atingiu ? "text-status-success" : "text-foreground")}>
              {fmtBRL(c.faturado)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Faixa DES</p>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-sm font-medium">{c.faixaEstrelas}★</span>
              <StarsRow count={c.faixaEstrelas} />
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Desc. próx. trimestre</p>
            <p className="text-sm font-medium mt-1">
              {fmtPct(c.ultimoCheckin?.desconto_total_projetado)}
            </p>
          </div>
        </div>
        {c.isAtual && c.meta > 0 && (
          <div className="mt-4 space-y-1">
            <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full transition-all",
                  progress >= 100 ? "bg-status-success" : progress >= 75 ? "bg-status-warning" : "bg-status-info",
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {progress.toFixed(1).replace(".", ",")}% da meta
            </p>
          </div>
        )}
        <div className="mt-4 pt-3 border-t border-border">
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onVerDetalhes(c)}>
            Ver detalhes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
