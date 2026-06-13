import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { classificarSituacao, diasSemVender, somarCapitalParado } from "@/lib/reposicao/baixo-giro-helpers";
import type { RowBaixoGiro } from "./types";

const HOJE_ISO = () => new Date().toISOString().slice(0, 10);

export function useBaixoGiro() {
  const { empresa } = useReposicaoEmpresa();

  const query = useQuery({
    queryKey: ["reposicao-baixo-giro", empresa],
    staleTime: 60_000,
    queryFn: async (): Promise<RowBaixoGiro[]> => {
      // 1) universo de baixo giro (cap defensivo 1000; baixo giro real < 1000)
      const { data: base, error } = await supabase
        .from("sku_parametros")
        .select("sku_codigo_omie, sku_descricao, fornecedor_nome, classe_consolidada, demanda_media_diaria, valor_vendido_90d, estoque_minimo, ponto_pedido, estoque_maximo, habilitado_reposicao_automatica, tipo_reposicao")
        .eq("empresa", empresa)
        .eq("ativo", true)
        .or("and(classe_abc.in.(B,C),classe_xyz.in.(Y,Z)),demanda_media_diaria.lt.0.05,estoque_minimo.is.null")
        .range(0, 999);
      if (error) throw error;
      const rowsBase = base ?? [];
      const codes = rowsBase.map((r) => Number(r.sku_codigo_omie));
      if (codes.length === 0) return [];

      // 2) enriquecimentos (.in)
      const [{ data: inv }, { data: dem }, { data: sug }] = await Promise.all([
        supabase.from("inventory_position").select("omie_codigo_produto, saldo, cmc").eq("account", empresa.toLowerCase()).in("omie_codigo_produto", codes),
        supabase.from("v_sku_demanda_estatisticas").select("sku_codigo_omie, ultima_venda_data").eq("empresa", empresa).in("sku_codigo_omie", codes),
        supabase.from("v_sku_parametros_sugeridos").select("sku_codigo_omie, status_sugestao").eq("empresa", empresa).in("sku_codigo_omie", codes),
      ]);
      const invMap = new Map((inv ?? []).map((r) => [Number(r.omie_codigo_produto), r]));
      const demMap = new Map((dem ?? []).map((r) => [Number(r.sku_codigo_omie), r]));
      const sugMap = new Map((sug ?? []).map((r) => [Number(r.sku_codigo_omie), r]));
      const hoje = HOJE_ISO();

      // 3) montar rows
      return rowsBase.map((r) => {
        const code = Number(r.sku_codigo_omie);
        const iv = invMap.get(code);
        const saldo = iv?.saldo ?? null;
        const cmc = iv?.cmc ?? null;
        const capital = saldo != null && saldo > 0 && cmc != null && cmc > 0 ? saldo * cmc : null;
        const status = sugMap.get(code)?.status_sugestao ?? null;
        const sit = classificarSituacao(status, r.estoque_minimo);
        return {
          id: String(code),
          sku_codigo_omie: code,
          sku_descricao: r.sku_descricao,
          fornecedor_nome: r.fornecedor_nome,
          classe_consolidada: r.classe_consolidada,
          saldo, cmc, capital_parado: capital,
          dias_sem_vender: diasSemVender(demMap.get(code)?.ultima_venda_data ?? null, hoje),
          demanda_media_diaria: r.demanda_media_diaria,
          valor_vendido_90d: r.valor_vendido_90d,
          status_sugestao: status,
          situacao_tipo: sit.tipo, situacao_label: sit.label, situacao_cta: sit.cta,
          estoque_minimo: r.estoque_minimo, ponto_pedido: r.ponto_pedido, estoque_maximo: r.estoque_maximo,
          habilitado_reposicao_automatica: r.habilitado_reposicao_automatica,
          tipo_reposicao: r.tipo_reposicao,
        };
      });
    },
  });

  const kpis = useMemo(() => {
    const rows = query.data ?? [];
    const cap = somarCapitalParado(rows.map((r) => ({ saldo: r.saldo, cmc: r.cmc })));
    return { ...cap, totalItens: rows.length };
  }, [query.data]);

  return { rows: query.data ?? [], kpis, isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}
