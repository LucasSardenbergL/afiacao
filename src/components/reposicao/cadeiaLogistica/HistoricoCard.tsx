// Card do histórico de mudanças da cadeia logística.
// Extraído verbatim de src/pages/AdminReposicaoCadeiaLogistica.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { History } from "lucide-react";
import { HistoricoItem } from "./types";

export function HistoricoCard({ historico }: { historico: HistoricoItem[] | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4" /> Histórico de mudanças
        </CardTitle>
      </CardHeader>
      <CardContent>
        {(historico ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem mudanças registradas.</p>
        ) : (
          <ul className="space-y-2">
            {(historico ?? []).map((h) => (
              <li
                key={h.id}
                className="text-sm border-l-2 border-muted pl-3 py-1"
              >
                <span className="text-muted-foreground text-xs">
                  {new Date(h.criado_em).toLocaleString("pt-BR")}
                </span>{" "}
                — <span className="font-medium">{h.fornecedor_nome}</span>:{" "}
                {h.descricao_mudanca}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
