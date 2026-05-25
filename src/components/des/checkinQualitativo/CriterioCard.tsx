// Card de um critério qualitativo (ou de bônus) do check-in DES.
// Extraído verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).
// Unifica os dois cards (qualitativo/bônus) que eram idênticos exceto pelas classes.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type Criterio, type Resposta } from "./types";
import { fmtPct } from "./format";

interface CriterioCardProps {
  criterio: Criterio;
  resposta: Resposta;
  percentual: number;
  bonus?: boolean;
  onChange: (resposta: Resposta) => void;
}

export function CriterioCard({ criterio: c, resposta: r, percentual: pct, bonus, onChange }: CriterioCardProps) {
  return (
    <Card
      className={cn(
        "transition-colors",
        bonus
          ? cn("border-amber-500/30", r.atingido && "bg-amber-500/10")
          : r.atingido && "bg-green-500/5 border-green-500/30",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm leading-tight">{c.nome}</CardTitle>
            {c.descricao && (
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                {c.descricao}
              </p>
            )}
          </div>
          <Badge
            variant="outline"
            className={cn("shrink-0 text-xs", bonus && "bg-amber-500/10 border-amber-500/40 text-amber-700")}
          >
            Vale {fmtPct(pct)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={r.atingido}
            onCheckedChange={(v) => onChange({ ...r, atingido: v })}
          />
          <label className="text-sm font-medium cursor-pointer">
            {r.atingido ? "Atingido" : "Não atingido"}
          </label>
        </div>
        {r.atingido && (
          <Textarea
            placeholder="Observação (opcional)..."
            value={r.observacao}
            onChange={(e) => onChange({ ...r, observacao: e.target.value })}
            className="text-xs min-h-[60px]"
          />
        )}
      </CardContent>
    </Card>
  );
}
