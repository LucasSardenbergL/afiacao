// Aba "Item inativo": cards de SKUs bloqueados por inativação.
// Extraída verbatim de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { type FilaItem } from "./types";

interface InativosTabProps {
  filteredItens: FilaItem[];
  isLoading: boolean;
  onSubstituicao: (it: FilaItem) => void;
  onDesativar: (sku: string) => void;
}

export function InativosTab({ filteredItens, isLoading, onSubstituicao, onDesativar }: InativosTabProps) {
  return (
    <>
      {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {!isLoading && (filteredItens?.length ?? 0) === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Nenhum SKU bloqueado por inativação. 🎉
        </p>
      )}
      {filteredItens.map((it) => (
        <Card key={it.id} className="border-destructive/30">
          <CardContent className="py-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-sm">{it.sku_codigo_omie}</div>
                <div className="font-medium">{it.sku_descricao}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Mensagem: {it.mensagem_bloqueio ?? "—"}
                </div>
              </div>
              <Badge variant="destructive">Item inativo</Badge>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" onClick={() => onSubstituicao(it)}>
                Registrar substituição
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDesativar(it.sku_codigo_omie)}
              >
                Descadastrar do módulo
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  toast.info(
                    "Marcado como reativação manual — aguardando próximo sync para revalidar."
                  )
                }
              >
                Reativar manualmente
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
