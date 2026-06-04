// Hook que, para os SKUs de um pedido, carrega os grupos de equivalência de
// embalagem + preços + demanda + custo de capital e roda o helper de decisão.
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  escolherEmbalagemEconomica,
  type DecisaoEmbalagem,
  type OpcaoEmbalagem,
  type StatusPreco,
} from '@/lib/reposicao/embalagem-helpers';
import type { PedidoItem } from './types';

interface EquivRow { empresa: string; grupo_id: string; sku_codigo_omie: string; unidade_base: string; fator_para_base: number; }
interface PrecoRow { sku_codigo_omie: string; preco: number; capturado_em: string; status: StatusPreco; }
interface ParamRow { sku_codigo_omie: number; custo_capital_efetivo_perc: number | null; }

export interface EmbalagemItemResult {
  decisao: DecisaoEmbalagem;
  /** SKUs do grupo — p/ o dialog pedir preço mesmo quando a decisão é "indisponível". */
  skusGrupo: string[];
}

export interface EmbalagemPedidoResult {
  /** sku_codigo_omie (do item do pedido) -> resultado de embalagem do grupo dele */
  porSku: Record<string, EmbalagemItemResult>;
  isLoading: boolean;
}

export function useEmbalagemPedido(
  empresa: string | undefined,
  itens: PedidoItem[] | undefined,
): EmbalagemPedidoResult {
  const skus = (itens ?? []).map((i) => String(i.sku_codigo_omie));

  const { data, isLoading } = useQuery({
    queryKey: ['embalagem-pedido', empresa, skus.join(',')],
    enabled: !!empresa && skus.length > 0,
    queryFn: async (): Promise<Record<string, EmbalagemItemResult>> => {
      if (!empresa) return {};

      // 1) Grupos a que os SKUs do pedido pertencem
      const equivResp = await supabase
        .from('sku_embalagem_equivalencia' as never)
        .select('empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base')
        .eq('empresa', empresa)
        .eq('ativo', true)
        .in('sku_codigo_omie', skus);
      const equivDoPedido = (equivResp.data ?? []) as unknown as EquivRow[];
      const gruposEnvolvidos = [...new Set(equivDoPedido.map((e) => e.grupo_id))];
      if (gruposEnvolvidos.length === 0) return {};

      // 2) TODOS os membros desses grupos (inclui a embalagem-irmã fora do pedido)
      const membrosResp = await supabase
        .from('sku_embalagem_equivalencia' as never)
        .select('empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base')
        .eq('empresa', empresa)
        .eq('ativo', true)
        .in('grupo_id', gruposEnvolvidos);
      const membros = (membrosResp.data ?? []) as unknown as EquivRow[];
      const skusGrupo = [...new Set(membros.map((m) => m.sku_codigo_omie))];

      // 3) Preço mais recente por SKU do grupo
      const precoResp = await supabase
        .from('sku_preco_fornecedor_capturado' as never)
        .select('sku_codigo_omie, preco, capturado_em, status')
        .eq('empresa', empresa)
        .in('sku_codigo_omie', skusGrupo)
        .order('capturado_em', { ascending: false });
      const precoRows = (precoResp.data ?? []) as unknown as PrecoRow[];
      const precoMap = new Map<string, PrecoRow>();
      for (const p of precoRows) {
        if (!precoMap.has(String(p.sku_codigo_omie))) precoMap.set(String(p.sku_codigo_omie), p);
      }

      // 4) Demanda + custo de capital por SKU (sku_parametros + view de parâmetros sugeridos)
      const skuNums = skusGrupo.map(Number).filter((n) => !Number.isNaN(n));
      const paramResp = await supabase
        .from('sku_parametros')
        .select('sku_codigo_omie, demanda_media_diaria')
        .eq('empresa', empresa)
        .in('sku_codigo_omie', skuNums);
      const demandaMap = new Map<string, number | null>();
      ((paramResp.data ?? []) as unknown as { sku_codigo_omie: number; demanda_media_diaria: number | null }[])
        .forEach((p) => demandaMap.set(String(p.sku_codigo_omie), p.demanda_media_diaria));

      const cmResp = await supabase
        .from('v_sku_parametros_sugeridos')
        .select('sku_codigo_omie, custo_capital_efetivo_perc')
        .eq('empresa', empresa)
        .in('sku_codigo_omie', skuNums);
      const cmMap = new Map<string, number | null>();
      ((cmResp.data ?? []) as unknown as ParamRow[])
        .forEach((p) => cmMap.set(String(p.sku_codigo_omie), p.custo_capital_efetivo_perc));

      // 5) Limiar de economia + janela de stale (company_config)
      const cfgResp = await supabase.from('company_config').select('value').eq('key', 'embalagem_limiar_economia_rs').maybeSingle();
      const limiar = Number((cfgResp.data?.value as string | undefined) ?? '5') || 5;
      const staleResp = await supabase.from('company_config').select('value').eq('key', 'embalagem_preco_stale_horas').maybeSingle();
      const staleHoras = Number((staleResp.data?.value as string | undefined) ?? '24') || 24;
      const agoraMs = Date.now();
      const statusComStale = (p: PrecoRow | undefined): StatusPreco | null => {
        if (!p) return null;
        if (p.status === 'falhou') return 'falhou';
        const idadeH = (agoraMs - Date.parse(p.capturado_em)) / 3_600_000;
        return idadeH > staleHoras ? 'stale' : (p.status ?? 'ok');
      };

      // 6) Opções por grupo
      const opcoesPorGrupo = new Map<string, OpcaoEmbalagem[]>();
      for (const m of membros) {
        const arr = opcoesPorGrupo.get(m.grupo_id) ?? [];
        const p = precoMap.get(m.sku_codigo_omie);
        arr.push({
          sku_codigo_omie: m.sku_codigo_omie,
          fator_para_base: Number(m.fator_para_base),
          preco: p ? Number(p.preco) : null,
          preco_status: statusComStale(p),
        });
        opcoesPorGrupo.set(m.grupo_id, arr);
      }

      // 7) Resultado por SKU do pedido
      const result: Record<string, EmbalagemItemResult> = {};
      for (const item of itens ?? []) {
        const sku = String(item.sku_codigo_omie);
        const membro = membros.find((m) => m.sku_codigo_omie === sku);
        if (!membro) continue;
        const opcoes = opcoesPorGrupo.get(membro.grupo_id);
        if (!opcoes) continue;
        const fator = Number(membro.fator_para_base);
        const qtdItem = Number(item.qtde_final ?? item.qtde_sugerida ?? 0);
        const necessidade_base = qtdItem * fator; // converte a qtd do SKU p/ unidade-base
        const demanda = demandaMap.get(sku) ?? null;
        const demanda_base = demanda != null ? demanda * fator : null;
        const cmPerc = cmMap.get(sku);
        const custo_capital_anual = cmPerc != null ? Number(cmPerc) / 100 : 0;
        const decisao = escolherEmbalagemEconomica({
          necessidade_base,
          opcoes,
          params: { custo_capital_anual, limiar_minimo_economia_rs: limiar, demanda_base_diaria: demanda_base },
        });
        result[sku] = { decisao, skusGrupo: opcoes.map((o) => o.sku_codigo_omie) };
      }
      return result;
    },
  });

  return { porSku: data ?? {}, isLoading };
}
