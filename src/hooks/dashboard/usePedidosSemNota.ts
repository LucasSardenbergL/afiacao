import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCompany } from '@/contexts/CompanyContext';
import { hojeSP } from '@/lib/dashboard/sp-date';
import { fetchPedidosSemNota } from '@/lib/dashboard/fetch-pedidos-sem-nota';
import {
  janelaSemNotaAntiga,
  resumirSemNota,
  resumirPorFaixa,
  clientesSemNotaRecentes,
  type ResumoSemNota,
  type ResumoFaixa,
  type ClienteSemNotaRecente,
} from '@/lib/dashboard/pedidos-sem-nota';

/** Quantos clientes da faixa 30–90d o banner detalha (ordenados por receita). */
export const TOPO_CLIENTES_SEM_NOTA = 10;

export interface PedidosSemNotaDados extends ResumoSemNota {
  janela: { de: string; ate: string };
  faixas: ResumoFaixa[];
  /** Topo dos clientes 30–90d; `clientesRecentesTotal` diz quantos existem ao todo. */
  clientesRecentes: ClienteSemNotaRecente[];
  clientesRecentesTotal: number;
  /** Nome por user_id (cliente e vendedor). `null` = a leitura de nomes FALHOU (≠ cadastro sem nome). */
  nomes: Map<string, string> | null;
}

/**
 * Pedidos de venda do último ano que seguem sem nota no Omie há mais de 30 dias, no escopo da empresa
 * do seletor. A leitura LANÇA em erro (paginada por cursor): o aviso mostra "não consegui medir", nunca
 * um zero fabricado — zero aqui é afirmação de que está tudo faturado. Os NOMES são best-effort: falha
 * vira `nomes: null` (o banner diz "nome indisponível"), sem derrubar o número medido.
 */
export function usePedidosSemNota() {
  const { selection } = useCompany();
  const hoje = hojeSP();
  const janela = janelaSemNotaAntiga(hoje);
  return useQuery({
    queryKey: ['pedidos-sem-nota', selection, janela.de, janela.ate],
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    queryFn: async (): Promise<PedidosSemNotaDados> => {
      const pedidos = await fetchPedidosSemNota(selection, janela);
      const recentes = clientesSemNotaRecentes(pedidos, hoje);
      const topo = recentes.slice(0, TOPO_CLIENTES_SEM_NOTA);

      const ids = new Set<string>();
      for (const c of topo) {
        ids.add(c.customerUserId);
        for (const p of c.pedidos) if (p.vendedorUserId) ids.add(p.vendedorUserId);
      }
      let nomes: Map<string, string> | null = new Map();
      if (ids.size > 0) {
        // ≤ ~30 ids (10 clientes + vendedores): um lote só, longe da capa de 1000 do PostgREST.
        const { data, error } = await supabase.from('profiles').select('user_id, name').in('user_id', [...ids]);
        if (error || !data) nomes = null;
        else for (const p of data) if (p.name) nomes.set(p.user_id, p.name);
      }

      return {
        ...resumirSemNota(pedidos),
        janela,
        faixas: resumirPorFaixa(pedidos, hoje),
        clientesRecentes: topo,
        clientesRecentesTotal: recentes.length,
        nomes,
      };
    },
  });
}
