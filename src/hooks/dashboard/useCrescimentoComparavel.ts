import { useQuery } from '@tanstack/react-query';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP } from '@/lib/dashboard/sp-date';
import {
  avaliarComparabilidade,
  coberturasPorEmpresa,
  decomporCrescimento,
  janelasTrimestreFechado,
  porEmpresaCliente,
  type Comparabilidade,
  type CoberturaEmpresa,
  type DecomposicaoCrescimento,
  type Janela,
} from '@/lib/dashboard/crescimento-comparavel';
import { fetchPedidosJanela } from '@/lib/dashboard/fetch-pedidos-janela';
import { fetchReceitaCompetencia } from '@/lib/dashboard/fetch-receita-competencia';

export type TipoComparacao = 'ano_anterior' | 'meses_anteriores';

export interface Comparacao {
  base: Janela;
  decomposicao: DecomposicaoCrescimento;
  coberturas: CoberturaEmpresa[];
  comparabilidade: Comparabilidade;
}

export interface CrescimentoComparavel {
  atual: Janela;
  comparacoes: Record<TipoComparacao, Comparacao>;
}

/**
 * Crescimento na base comparável (empresa × cliente) dos 3 últimos meses fechados, contra o mesmo
 * trimestre do ano anterior e contra os 3 meses anteriores. Pedidos LANÇAM em erro (o card mostra
 * erro, nunca uma ponte parcial). O DRE é a régua de cobertura: se ele falhar, a decomposição
 * continua e a comparabilidade cai para "não verificada" — sem fabricar "comparável".
 * Spec: docs/superpowers/specs/2026-10-10-crescimento-base-comparavel-design.md
 */
export function useCrescimentoComparavel() {
  const { selection } = useCompany();
  const janelas = janelasTrimestreFechado(hojeSP());
  return useQuery({
    queryKey: ['crescimento-comparavel', selection, janelas.atual.de, janelas.atual.ate],
    // Meses fechados: o número muda pouco ao longo do dia.
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    queryFn: async (): Promise<CrescimentoComparavel> => {
      const dreOuNull = (j: Janela) => fetchReceitaCompetencia(selection, j).catch(() => null);
      const [pAtual, pAno, pMeses, dAtual, dAno, dMeses] = await Promise.all([
        fetchPedidosJanela(selection, janelas.atual),
        fetchPedidosJanela(selection, janelas.anoAnterior),
        fetchPedidosJanela(selection, janelas.anterior),
        dreOuNull(janelas.atual),
        dreOuNull(janelas.anoAnterior),
        dreOuNull(janelas.anterior),
      ]);
      const atualCliente = porEmpresaCliente(pAtual);
      const comparar = (base: Janela, pBase: typeof pAtual, dBase: Map<string, number> | null): Comparacao => {
        const coberturas = coberturasPorEmpresa(pAtual, pBase, dAtual, dBase);
        return {
          base,
          decomposicao: decomporCrescimento(atualCliente, porEmpresaCliente(pBase)),
          coberturas,
          comparabilidade: avaliarComparabilidade(coberturas),
        };
      };
      return {
        atual: janelas.atual,
        comparacoes: {
          ano_anterior: comparar(janelas.anoAnterior, pAno, dAno),
          meses_anteriores: comparar(janelas.anterior, pMeses, dMeses),
        },
      };
    },
  });
}
