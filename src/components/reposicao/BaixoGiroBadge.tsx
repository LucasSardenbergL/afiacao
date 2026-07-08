import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Boxes, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { REPOSICAO_EMPRESA } from "@/hooks/useReposicaoSessao";
import { BAIXO_GIRO_OR_FILTER } from "@/lib/reposicao/baixo-giro-helpers";

/**
 * Atalho discreto do cockpit para o painel "Baixo giro & estoque parado".
 * Substituiu a antiga faixa amarela de "SKUs sem parâmetro" (SmartAlertsSection):
 * aquela parecia pendência de automação sem ser — itens de baixo giro NÃO são falha
 * do auto-apply, são cauda longa sem venda recente, já tratados no painel dedicado.
 * Aqui fica só o pulso (quantos itens) + o caminho, sem cara de alerta.
 * A contagem reusa o MESMO filtro do painel (BAIXO_GIRO_OR_FILTER) para bater com a lista.
 */
export function BaixoGiroBadge() {
  const navigate = useNavigate();

  const { data: total = 0 } = useQuery({
    queryKey: ["cockpit-baixo-giro-total", REPOSICAO_EMPRESA],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("sku_parametros")
        .select("*", { count: "exact", head: true })
        .eq("empresa", REPOSICAO_EMPRESA)
        .eq("ativo", true)
        .or(BAIXO_GIRO_OR_FILTER);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });

  if (total === 0) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => navigate("/admin/reposicao/baixo-giro")}
      className="w-fit text-muted-foreground hover:text-foreground"
      title="Ver itens de baixo giro e estoque parado"
    >
      <Boxes className="h-4 w-4 mr-1.5" />
      Baixo giro &amp; estoque parado
      <Badge variant="secondary" className="ml-2 tabular-nums">
        {total}
      </Badge>
      <ChevronRight className="h-4 w-4 ml-1 opacity-60" />
    </Button>
  );
}
