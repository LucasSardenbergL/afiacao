// Card de substituição pendente (aba Substituição) da tela de Aplicação no Omie.
// Extraído de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { useQuery, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { type FilaItem } from "@/components/reposicao/aplicacao/types";

export function SubstituicaoPendenteCard({
  item,
  onChange,
}: {
  item: FilaItem;
  onChange: () => void;
}) {
  const { data: subst } = useQuery({
    queryKey: ["sku-substituicao", item.empresa, item.sku_codigo_omie],
    queryFn: async () => {
      const { data } = await supabase
        .from("sku_substituicao")
        .select("*")
        .eq("empresa", item.empresa)
        .eq("sku_codigo_antigo", item.sku_codigo_omie)
        .eq("status", "pendente")
        .maybeSingle();
      return data;
    },
  });

  const cancelarSubst = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("sku_substituicao")
        .update({ status: "cancelada" } as never)
        .eq("id", subst!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Substituição cancelada");
      onChange();
    },
  });

  const aplicarSubst = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("sku_substituicao")
        .update({ status: "aplicada", aplicado_em: new Date().toISOString() } as never)
        .eq("id", subst!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Substituição aplicada. Regere a fila para revalidar.");
      onChange();
    },
  });

  return (
    <Card className="border-warning/40">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-sm">{item.sku_codigo_omie} (antigo)</div>
            <div className="font-medium">{item.sku_descricao}</div>
            {subst && (
              <div className="mt-2 text-xs">
                <div>
                  <span className="text-muted-foreground">SKU novo: </span>
                  <span className="font-mono">{subst.sku_codigo_novo}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Ação: </span>
                  <Badge variant="outline">{subst.acao_parametros}</Badge>
                </div>
                <div className="text-muted-foreground mt-1">
                  Motivo: {subst.motivo ?? "—"}
                </div>
              </div>
            )}
          </div>
          <Badge className="bg-warning/20 text-warning-foreground">Substituição pendente</Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => aplicarSubst.mutate()} disabled={!subst}>
            Aplicar substituição
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => cancelarSubst.mutate()}
            disabled={!subst}
          >
            Cancelar substituição
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
