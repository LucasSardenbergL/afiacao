/**
 * Hooks de dados para o casamento catalisador_codigo (normalizado) ↔ SKU Omie — venda assistida Fatia 3.
 *
 *  1. useCatalisadorLinksMap   — mapa GLOBAL (todos os confirmados) p/ o selo: keyDeCatalisador → SKUs
 *  2. useCatalisadorLinks      — links de UM código (com nome/código do omie_products) p/ a UI do detalhe
 *  3. useConfirmarCatalisador  — confirmar casamento (master)
 *  4. useDesvincularCatalisador— remover um SKU do catalisador (master, anti-stale)
 *
 * Busca de candidatos: reusa `useBuscarSkusCandidatos` de useProductSpecLink (mesma RPC).
 * ⚠️ Tabela/RPCs novas NÃO estão no types.ts → cast `as never` (lição §10 — não editar types.ts).
 */

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  normalizarCatalisador,
  keyDeCatalisador,
  type CatalisadorLink,
} from '@/lib/knowledge-base/catalisador-link';

type RpcFn = typeof supabase.rpc;

interface MapRow {
  catalisador_codigo_norm: string;
  account: string;
  omie_codigo_produto: number;
}
interface LinkRow {
  account: string;
  omie_codigo_produto: number;
}
interface ProdutoRow {
  account: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. useCatalisadorLinksMap — mapa global p/ o selo da venda assistida
// ─────────────────────────────────────────────────────────────────────────────
export function useCatalisadorLinksMap() {
  const { data, isLoading } = useQuery<MapRow[]>({
    queryKey: ['kb-catalisador-map'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: rows, error } = (await supabase
        .from('kb_catalisador_links' as never)
        .select('catalisador_codigo_norm, account, omie_codigo_produto')
        .eq('status', 'confirmed')) as {
        data: MapRow[] | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(error.message);
      return rows ?? [];
    },
  });

  const byKey = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const r of data ?? []) {
      const k = keyDeCatalisador(r.catalisador_codigo_norm, r.account);
      const arr = m.get(k);
      if (arr) arr.push(r.omie_codigo_produto);
      else m.set(k, [r.omie_codigo_produto]);
    }
    return m;
  }, [data]);

  return { byKey, isLoading };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. useCatalisadorLinks — links de UM código (p/ a UI do detalhe do boletim)
// ─────────────────────────────────────────────────────────────────────────────
export function useCatalisadorLinks(codigoRaw?: string | null) {
  const norm = normalizarCatalisador(codigoRaw);
  const {
    data: links = [],
    isLoading,
    refetch,
  } = useQuery<CatalisadorLink[]>({
    queryKey: ['kb-catalisador-links', norm],
    enabled: norm !== '',
    queryFn: async (): Promise<CatalisadorLink[]> => {
      const { data: linkRows, error: linkErr } = (await supabase
        .from('kb_catalisador_links' as never)
        .select('account, omie_codigo_produto')
        .eq('catalisador_codigo_norm', norm)
        .eq('status', 'confirmed')) as {
        data: LinkRow[] | null;
        error: { message: string } | null;
      };
      if (linkErr) throw new Error(linkErr.message);
      if (!linkRows || linkRows.length === 0) return [];

      const codes = linkRows.map((r) => r.omie_codigo_produto);
      const { data: prodRows, error: prodErr } = (await supabase
        .from('omie_products')
        .select('account, omie_codigo_produto, codigo, descricao')
        .in('omie_codigo_produto', codes)) as unknown as {
        data: ProdutoRow[] | null;
        error: { message: string } | null;
      };
      if (prodErr) throw new Error(prodErr.message);

      const prodMap = new Map<string, ProdutoRow>();
      for (const p of prodRows ?? []) {
        prodMap.set(keyDeCatalisador(String(p.omie_codigo_produto), p.account), p);
      }
      return linkRows.map((l): CatalisadorLink => {
        const match = prodMap.get(keyDeCatalisador(String(l.omie_codigo_produto), l.account));
        return {
          catalisador_codigo_norm: norm,
          account: l.account,
          omie_codigo_produto: l.omie_codigo_produto,
          codigo: match?.codigo ?? null,
          descricao: match?.descricao ?? null,
        };
      });
    },
  });

  return { links, norm, isLoading, refetch };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. useConfirmarCatalisador — gravar o casamento (master)
// ─────────────────────────────────────────────────────────────────────────────
interface ConfirmarArgs {
  codigo: string;
  skus: { account: string; omie_codigo_produto: number }[];
}
export function useConfirmarCatalisador() {
  const queryClient = useQueryClient();
  return useMutation<number, Error, ConfirmarArgs>({
    mutationFn: async ({ codigo, skus }: ConfirmarArgs) => {
      const { data, error } = (await (supabase.rpc as RpcFn)(
        'confirmar_catalisador_vinculo' as never,
        { p_catalisador_codigo: codigo, p_skus: skus } as never,
      )) as { data: number | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data ?? 0;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-catalisador-links'] });
      queryClient.invalidateQueries({ queryKey: ['kb-catalisador-map'] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Falha ao casar o catalisador');
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. useDesvincularCatalisador — remover um SKU do catalisador (master, anti-stale)
// ─────────────────────────────────────────────────────────────────────────────
interface DesvincularArgs {
  account: string;
  omie_codigo_produto: number;
  expectedNorm: string;
}
export function useDesvincularCatalisador() {
  const queryClient = useQueryClient();
  return useMutation<number, Error, DesvincularArgs>({
    mutationFn: async ({ account, omie_codigo_produto, expectedNorm }: DesvincularArgs) => {
      const { data, error } = (await (supabase.rpc as RpcFn)(
        'desvincular_catalisador' as never,
        {
          p_account: account,
          p_omie_codigo_produto: omie_codigo_produto,
          p_expected_norm: expectedNorm,
        } as never,
      )) as { data: number | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data ?? 0;
    },
    onSuccess: (deleted) => {
      if (deleted === 0) {
        toast.message('Nada mudou (talvez já tenha sido reatribuído).');
      } else {
        toast.success('Catalisador desvinculado.');
      }
      queryClient.invalidateQueries({ queryKey: ['kb-catalisador-links'] });
      queryClient.invalidateQueries({ queryKey: ['kb-catalisador-map'] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Falha ao desvincular o catalisador');
    },
  });
}
