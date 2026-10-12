import { useQuery } from '@tanstack/react-query';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP } from '@/lib/dashboard/sp-date';
import { fetchPedidosSemNota } from '@/lib/dashboard/fetch-pedidos-sem-nota';
import { janelaSemNotaAntiga, resumirSemNota, type ResumoSemNota } from '@/lib/dashboard/pedidos-sem-nota';

/**
 * Pedidos de venda do último ano que seguem sem nota no Omie há mais de 30 dias, no escopo da empresa
 * do seletor. A leitura LANÇA em erro (paginada por cursor): o aviso mostra "não consegui medir", nunca
 * um zero fabricado — zero aqui é afirmação de que está tudo faturado.
 */
export function usePedidosSemNota() {
  const { selection } = useCompany();
  const janela = janelaSemNotaAntiga(hojeSP());
  return useQuery({
    queryKey: ['pedidos-sem-nota', selection, janela.de, janela.ate],
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    queryFn: async (): Promise<ResumoSemNota & { janela: typeof janela }> => {
      const pedidos = await fetchPedidosSemNota(selection, janela);
      return { ...resumirSemNota(pedidos), janela };
    },
  });
}
