// Cabeçalho da tela de aplicação no Omie (última sync + ações).
// Extraído verbatim de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { RefreshCw, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AplicacaoHeaderProps {
  ultimoSync: string | null | undefined;
  syncDesatualizado: boolean;
  onSincronizar: () => void;
  sincronizarPending: boolean;
  onGerarFila: () => void;
  gerarFilaPending: boolean;
}

export function AplicacaoHeader({
  ultimoSync,
  syncDesatualizado,
  onSincronizar,
  sincronizarPending,
  onGerarFila,
  gerarFilaPending,
}: AplicacaoHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-2xl font-bold">Aplicação no Omie</h1>
        <p className="text-sm text-muted-foreground">
          Gere e aplique parâmetros de reposição diretamente no ERP, com validação de prontidão.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-xs text-right">
          <div className="text-muted-foreground">Última sync Omie</div>
          <div
            className={
              syncDesatualizado ? "text-destructive font-medium" : "text-foreground font-medium"
            }
          >
            {ultimoSync
              ? formatDistanceToNow(new Date(ultimoSync), { addSuffix: true, locale: ptBR })
              : "nunca"}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onSincronizar}
          disabled={sincronizarPending}
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${sincronizarPending ? "animate-spin" : ""}`}
          />
          Sincronizar agora
        </Button>
        <Button onClick={onGerarFila} disabled={gerarFilaPending}>
          <PlayCircle className="h-4 w-4 mr-2" />
          Gerar fila
        </Button>
      </div>
    </header>
  );
}
