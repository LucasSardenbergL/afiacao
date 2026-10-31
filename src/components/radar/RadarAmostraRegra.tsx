import { FlaskConical } from 'lucide-react';
import { PASSO_AMOSTRA, type ResumoAmostra } from '@/lib/radar/amostra';

/**
 * A regra de exploração, VISÍVEL acima da fila: o vendedor vê por que um lead de score mais baixo está ali e quantos
 * da amostra ainda faltam. O resumo conta o sorteio inteiro (denominador fixo): quem saiu da fila aparece no motivo.
 */
export function RadarAmostraRegra({
  sorteio,
  resumo,
  naFila,
  erro,
}: {
  sorteio: string | null;
  resumo: ResumoAmostra | null;
  /** Pendentes que os filtros digitados (busca, UF, cidade, CNAE, status) deixam na fila. */
  naFila: number;
  erro: string | null;
}) {
  if (erro) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs" data-testid="amostra-erro">
        <FlaskConical className="w-4 h-4 text-status-warning shrink-0" />
        <span>Amostra de controle indisponível ({erro}). A fila segue só pelo score.</span>
      </div>
    );
  }
  if (!sorteio || !resumo) return null;
  const fora = resumo.descartados + resumo.jaClientes + resumo.semDados;
  const ocultos = resumo.pendentes - naFila;
  return (
    <div className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground" data-testid="amostra-regra">
      <FlaskConical className="w-4 h-4 shrink-0 mt-px" />
      <p>
        <span className="text-foreground font-medium">Exploração:</span> 1 lead da amostra de controle a cada {PASSO_AMOSTRA} posições
        (selo <span className="text-status-info">amostra</span>), para comparar a conversão de fora do topo com a do topo
        ({sorteio}). Aparece com qualquer região ou “só sugeridos”.{' '}
        <span className="tabular-nums">
          {resumo.pendentes} de {resumo.total} a contatar · {resumo.contatados} contatado{resumo.contatados === 1 ? '' : 's'}
          {fora > 0 && ` · ${fora} fora da fila (${[
            resumo.descartados > 0 && `${resumo.descartados} descartado${resumo.descartados === 1 ? '' : 's'}`,
            resumo.jaClientes > 0 && `${resumo.jaClientes} já cliente${resumo.jaClientes === 1 ? '' : 's'}`,
            resumo.semDados > 0 && `${resumo.semDados} sem dados`,
          ].filter(Boolean).join(', ')}) — não são substituídos`}
          {resumo.pendentesForaDaAtuacao > 0 && ` · inclui ${resumo.pendentesForaDaAtuacao} fora da região de atuação (${resumo.ufsForaDaAtuacao.join(', ')})`}
          {ocultos > 0 && ` · ${ocultos} escondido${ocultos === 1 ? '' : 's'} pela busca/UF/cidade/CNAE/status`}
        </span>
      </p>
    </div>
  );
}
