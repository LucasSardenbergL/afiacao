// Rodapé de paginação do ranking completo (BLOCO 2).
// Extraído verbatim de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
import { Button } from "@/components/ui/button";

interface RankingPaginacaoProps {
  paginaAtual: number;
  totalPaginas: number;
  pageSize: number;
  totalFiltrado: number;
  onAnterior: () => void;
  onProxima: () => void;
}

export function RankingPaginacao({
  paginaAtual,
  totalPaginas,
  pageSize,
  totalFiltrado,
  onAnterior,
  onProxima,
}: RankingPaginacaoProps) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <p className="text-xs text-muted-foreground">
        Mostrando {totalFiltrado === 0 ? 0 : (paginaAtual - 1) * pageSize + 1}–
        {Math.min(paginaAtual * pageSize, totalFiltrado)} de {totalFiltrado} SKUs ranqueados
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={paginaAtual === 1} onClick={onAnterior}>
          Anterior
        </Button>
        <span className="text-xs text-muted-foreground">
          {paginaAtual} / {totalPaginas}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={paginaAtual >= totalPaginas}
          onClick={onProxima}
        >
          Próxima
        </Button>
      </div>
    </div>
  );
}
