/**
 * Hooks de dados para o casamento boletim técnico ↔ SKU Omie.
 *
 * Cinco hooks:
 *  1. useCurrentSpecsMap  — mapa completo de fichas ativas (view)
 *  2. useSpecLinks        — SKUs vinculados a um boletim específico
 *  3. useBuscarSkusCandidatos — busca de SKUs candidatos via RPC
 *  4. useConfirmarVinculo — confirmar vínculo boletim↔SKUs (master)
 *  5. useDesvincularBoletim — remover vínculo específico (master)
 *
 * ⚠️ View e RPCs novas NÃO estão no types.ts gerado → cast `as never`
 * (lição §10 CLAUDE.md — não editar types.ts).
 */

import { useMemo } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  type CurrentSpec,
  type SkuCandidato,
  type VinculoLinha,
  keyDeSku,
} from '@/lib/knowledge-base/spec-link';

// Alias para o cast de RPC não-tipada (mesma convenção de useRadarAcoesLead.ts)
type RpcFn = typeof supabase.rpc;

// ─────────────────────────────────────────────────────────────────────────────
// 1. useCurrentSpecsMap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Carrega todas as fichas ativas da view `v_omie_product_current_spec`
 * e expõe um Map<"account|cod", CurrentSpec> para lookup O(1).
 *
 * @param account Se fornecido, filtra por empresa (ex.: 'oben').
 */
export function useCurrentSpecsMap(account?: string) {
  const { data, isLoading } = useQuery<CurrentSpec[]>({
    queryKey: ['kb-current-specs', account],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // Cast pra `any` no builder não-tipado — única forma de encadear .eq()
      // condicionalmente sem que o strict-mode rejeite a reatribuição.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = supabase
        .from('v_omie_product_current_spec' as never)
        .select('*');
      if (account) {
        query = query.eq('account', account);
      }
      const { data: rows, error } = (await query) as {
        data: CurrentSpec[] | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(error.message);
      return rows ?? [];
    },
  });

  const byKey = useMemo(() => {
    const m = new Map<string, CurrentSpec>();
    for (const row of data ?? []) {
      m.set(keyDeSku(row.account, row.omie_codigo_produto), row);
    }
    return m;
  }, [data]);

  return { byKey, isLoading };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. useSpecLinks
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Carrega os SKUs vinculados a um boletim específico, mesclando com os dados
 * de nome/código de `omie_products`.
 *
 * Retorna `VinculoLinha[]` — `codigo`/`descricao` = null se o SKU existir no
 * link mas não na tabela de produtos (edge-case, tratado honestamente).
 */
export function useSpecLinks(specId?: string) {
  const {
    data: links = [],
    isLoading,
    refetch,
  } = useQuery<VinculoLinha[]>({
    queryKey: ['kb-spec-links', specId],
    enabled: !!specId,
    queryFn: async (): Promise<VinculoLinha[]> => {
      // (a) buscar os links confirmados
      const { data: linkRows, error: linkErr } = await (
        supabase
          .from('omie_product_spec_links' as never)
          .select('account, omie_codigo_produto')
          .eq('kb_product_spec_id', specId!)
          .eq('status', 'confirmed') as unknown as Promise<{
          data: LinkRow[] | null;
          error: { message: string } | null;
        }>
      );
      if (linkErr) throw new Error(linkErr.message);
      if (!linkRows || linkRows.length === 0) return [];

      // (b) buscar nomes/códigos de omie_products
      const codes = linkRows.map((r) => r.omie_codigo_produto);
      const { data: prodRows, error: prodErr } = await (
        supabase
          .from('omie_products')
          .select('account, omie_codigo_produto, codigo, descricao')
          .in('omie_codigo_produto', codes) as unknown as Promise<{
          data: ProdutoRow[] | null;
          error: { message: string } | null;
        }>
      );
      if (prodErr) throw new Error(prodErr.message);

      // (c) merge por keyDeSku(account, cod)
      const prodMap = new Map<string, ProdutoRow>();
      for (const p of prodRows ?? []) {
        prodMap.set(keyDeSku(p.account, p.omie_codigo_produto), p);
      }

      return linkRows.map((l): VinculoLinha => {
        const match = prodMap.get(keyDeSku(l.account, l.omie_codigo_produto));
        return {
          account: l.account,
          omie_codigo_produto: l.omie_codigo_produto,
          codigo: match?.codigo ?? null,
          descricao: match?.descricao ?? null,
        };
      });
    },
  });

  return { links, isLoading, refetch };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. useBuscarSkusCandidatos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca SKUs candidatos ao vínculo via RPC `buscar_skus_candidatos`.
 * Aceita um array de termos de busca (ex.: ['FI.6197', 'ISOLANTE']).
 */
export function useBuscarSkusCandidatos() {
  return useMutation<SkuCandidato[], Error, string[]>({
    mutationFn: async (termos: string[]) => {
      const { data, error } = await (
        (supabase.rpc as RpcFn)(
          'buscar_skus_candidatos' as never,
          { p_termos: termos } as never,
        ) as unknown as Promise<{
          data: SkuCandidato[] | null;
          error: { message: string } | null;
        }>
      );
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Falha na busca de SKUs');
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. useConfirmarVinculo
// ─────────────────────────────────────────────────────────────────────────────

interface ConfirmarArgs {
  specId: string;
  skus: { account: string; omie_codigo_produto: number }[];
}

/**
 * Confirma o vínculo entre um boletim e um ou mais SKUs.
 * Gate master no servidor — o front só chama se isMaster.
 * Invalida ['kb-spec-links', *] e ['kb-current-specs', *] no sucesso.
 */
export function useConfirmarVinculo() {
  const queryClient = useQueryClient();

  return useMutation<number, Error, ConfirmarArgs>({
    mutationFn: async ({ specId, skus }: ConfirmarArgs) => {
      const { data, error } = await (
        (supabase.rpc as RpcFn)(
          'confirmar_vinculo_boletim' as never,
          {
            p_kb_product_spec_id: specId,
            p_skus: skus,
          } as never,
        ) as unknown as Promise<{
          data: number | null;
          error: { message: string } | null;
        }>
      );
      if (error) throw new Error(error.message);
      return data ?? 0;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['kb-spec-links'] });
      queryClient.invalidateQueries({ queryKey: ['kb-current-specs'] });
    },
    onError: (e) => {
      toast.error(
        e instanceof Error ? e.message : 'Falha ao vincular boletim ao SKU',
      );
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. useDesvincularBoletim
// ─────────────────────────────────────────────────────────────────────────────

interface DesvincularArgs {
  account: string;
  omie_codigo_produto: number;
  expectedSpecId: string;
}

/**
 * Remove um vínculo confirmado entre boletim e SKU.
 * Usa `p_expected_kb_product_spec_id` como guard anti-stale-delete
 * (aba atrasada não apaga vínculo já reatribuído).
 * Retorna 0 se nada bateu (informa ao usuário via toast).
 */
export function useDesvincularBoletim() {
  const queryClient = useQueryClient();

  return useMutation<number, Error, DesvincularArgs>({
    mutationFn: async ({
      account,
      omie_codigo_produto,
      expectedSpecId,
    }: DesvincularArgs) => {
      const { data, error } = await (
        (supabase.rpc as RpcFn)(
          'desvincular_boletim' as never,
          {
            p_account: account,
            p_omie_codigo_produto: omie_codigo_produto,
            p_expected_kb_product_spec_id: expectedSpecId,
          } as never,
        ) as unknown as Promise<{
          data: number | null;
          error: { message: string } | null;
        }>
      );
      if (error) throw new Error(error.message);
      return data ?? 0;
    },
    onSuccess: (deleted) => {
      if (deleted === 0) {
        toast.message('Nada mudou (talvez o vínculo já tenha sido reatribuído).');
      } else {
        toast.success('Vínculo removido.');
      }
      queryClient.invalidateQueries({ queryKey: ['kb-spec-links'] });
      queryClient.invalidateQueries({ queryKey: ['kb-current-specs'] });
    },
    onError: (e) => {
      toast.error(
        e instanceof Error ? e.message : 'Falha ao remover vínculo',
      );
    },
  });
}
