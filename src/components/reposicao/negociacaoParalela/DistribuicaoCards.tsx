// Cards de distribuição por categoria do ranking (BLOCO 2).
// Extraídos verbatim de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type Categoria } from "./types";
import { categoriaBadgeClass, categoriaLabel } from "./helpers";

interface DistribuicaoCardsProps {
  distribuicao: Record<Categoria, number>;
}

export function DistribuicaoCards({ distribuicao }: DistribuicaoCardsProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {(["prioritario", "forte", "moderado", "fraco"] as Categoria[]).map((c) => (
        <Card key={c}>
          <CardContent className="py-3">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline" className={cn("uppercase text-[10px]", categoriaBadgeClass(c))}>
                {categoriaLabel(c)}
              </Badge>
              <span className="text-xl font-semibold">{distribuicao[c]}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
