import { useNavigate } from "react-router-dom";
import { Boxes, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBaixoGiro } from "@/components/reposicao/baixoGiro/useBaixoGiro";

const fmtBRLCompacto = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);

/**
 * Atalho discreto do cockpit para o painel "Baixo giro & estoque parado".
 * Substituiu a antiga faixa amarela de "SKUs sem parâmetro" (SmartAlertsSection):
 * aquela parecia pendência de automação sem ser — itens de baixo giro NÃO são falha
 * do auto-apply, são cauda longa sem venda recente, já tratados no painel dedicado.
 * Aqui fica só o pulso (quantos itens + R$ de capital parado) + o caminho, sem alerta.
 *
 * Reusa o hook `useBaixoGiro` do painel — mesma queryKey → cache compartilhado e
 * números IDÊNTICOS aos do painel (fonte única do universo e do capital, via
 * somarCapitalParado). Nada de query/soma própria: dois cálculos de dinheiro que
 * podem divergir é o pecado recorrente do domínio.
 */
export function BaixoGiroBadge() {
  const navigate = useNavigate();
  const { kpis, isLoading } = useBaixoGiro();

  if (isLoading || kpis.totalItens === 0) return null;

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
      <span className="mx-1.5 opacity-40" aria-hidden="true">·</span>
      <span className="tabular-nums">
        {kpis.totalItens} {kpis.totalItens === 1 ? "item" : "itens"}
      </span>
      {kpis.totalRs > 0 && (
        <>
          <span className="mx-1.5 opacity-40" aria-hidden="true">·</span>
          <span className="font-medium text-foreground tabular-nums">
            {fmtBRLCompacto(kpis.totalRs)} parado
          </span>
        </>
      )}
      <ChevronRight className="h-4 w-4 ml-1.5 opacity-60" />
    </Button>
  );
}
