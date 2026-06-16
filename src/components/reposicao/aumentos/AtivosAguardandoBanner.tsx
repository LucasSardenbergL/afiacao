// Banner de aumentos ativos aguardando vigência.
// Extraído verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split).
import { TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface AtivosAguardandoBannerProps {
  count: number;
  onVerAtivos: () => void;
}

export function AtivosAguardandoBanner({ count: ativosAguardando, onVerAtivos }: AtivosAguardandoBannerProps) {
  return (
    <Card className="border-status-info/40 bg-status-info/5">
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-status-info" />
          <div>
            <p className="font-medium">
              {ativosAguardando}{" "}
              {ativosAguardando === 1
                ? "aumento ativo aguardando vigência"
                : "aumentos ativos aguardando vigência"}
            </p>
            <p className="text-sm text-muted-foreground">
              Confirmados, aguardando a data de início.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onVerAtivos}
        >
          Ver ativos
        </Button>
      </CardContent>
    </Card>
  );
}
