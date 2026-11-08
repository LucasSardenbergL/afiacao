import { useQuery, type QueryClient } from '@tanstack/react-query';
import { lerEmpresaRadar } from '@/queries/useRadarConflitosCadastro';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Um lead do Radar lido pelo CNPJ: a ficha aberta FORA da fila carregada (link do card ou do e-mail, conflito de
 * cadastro, lead que saiu da fila depois de virar cliente). A chave fica sob `['radar']` de propósito: o
 * `invalidarRadar` de toda mutação (cadastro no Omie, contato, descarte) relê a ficha junto com a fila, em vez de ela
 * ficar num snapshot que nenhuma invalidação alcança (pacote I, item 1). `null` = o lead não existe no Radar.
 */
const chaveEmpresaRadar = (cnpj: string) => ['radar', 'empresa', cnpj] as const;

export function useRadarEmpresa(cnpj: string | null, opcoes: { ativo: boolean }) {
  return useQuery({
    queryKey: chaveEmpresaRadar(cnpj ?? ''),
    enabled: !!cnpj && opcoes.ativo,
    staleTime: 60_000,
    queryFn: (): Promise<RadarEmpresa | null> => lerEmpresaRadar(cnpj as string),
  });
}

/** Lê pelo cache da mesma query (para quem abre a ficha por CNPJ fora de um componente com o hook). */
export function buscarEmpresaRadar(qc: QueryClient, cnpj: string): Promise<RadarEmpresa | null> {
  return qc.fetchQuery({ queryKey: chaveEmpresaRadar(cnpj), staleTime: 60_000, queryFn: () => lerEmpresaRadar(cnpj) });
}
