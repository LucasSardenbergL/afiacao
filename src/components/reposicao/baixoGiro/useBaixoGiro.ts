import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { BAIXO_GIRO_OR_FILTER, classificarSituacao, diasSemVender, ehGiroMorto, somarCapitalMorto, somarCapitalParado } from "@/lib/reposicao/baixo-giro-helpers";
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
        .select("sku_codigo_omie, sku_descricao, fornecedor_nome, classe_consolidada, demanda_media_diaria, valor_vendido_90d, estoque_minimo, ponto_pedido, estoque_maximo, habilitado_reposicao_automatica, tipo_reposicao, parametro_cold_start")
        .eq("empresa", empresa)
        .eq("ativo", true)
        .or(BAIXO_GIRO_OR_FILTER)
        .range(0, 999);
      if (error) throw error;
      const rowsBase = base ?? [];
      const codes = rowsBase.map((r) => Number(r.sku_codigo_omie));
      if (codes.length === 0) return [];

      // 2) enriquecimentos (.in) — última venda vem da fonte ALL-TIME (v_sku_ultima_venda):
      // a v_sku_demanda_estatisticas é janelada em 90d e mostrava "nunca" p/ quem vendeu há 4 meses.
      // (cast: a view é da migration 20260731120000 e só entra nos types gerados no próximo type-gen)
      const [{ data: inv }, demRes, { data: sug }] = await Promise.all([
        supabase.from("inventory_position").select("omie_codigo_produto, saldo, cmc").eq("account", empresa.toLowerCase()).in("omie_codigo_produto", codes),
        supabase.from("v_sku_ultima_venda" as never).select("sku_codigo_omie, ultima_venda_data, vendas_registradas").eq("empresa", empresa).in("sku_codigo_omie", codes) as unknown as PromiseLike<{
          data: { sku_codigo_omie: number; ultima_venda_data: string | null; vendas_registradas: number }[] | null;
          error: unknown;
        }>,
        supabase.from("v_sku_parametros_sugeridos").select("sku_codigo_omie, status_sugestao").eq("empresa", empresa).in("sku_codigo_omie", codes),
      ]);
      // Falha na fonte do giro morto LANÇA — "não consegui ler a última venda" viraria
      // vendas_registradas=0 ⇒ giro_morto=true na lista INTEIRA (veredito de descontinuar
      // fabricado por falha de transporte). Ausente ≠ zero vale para leitura também.
      if (demRes.error != null) throw demRes.error instanceof Error ? demRes.error : new Error("v_sku_ultima_venda: leitura falhou");
      const dem = demRes.data;
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
        const ultimaVenda = demMap.get(code);
        const vendasRegistradas = Number(ultimaVenda?.vendas_registradas ?? 0);
        const dias = diasSemVender(ultimaVenda?.ultima_venda_data ?? null, hoje);
        const emColdStart = r.parametro_cold_start === true || sit.cta === "cold_start";
        return {
          id: String(code),
          sku_codigo_omie: code,
          sku_descricao: r.sku_descricao,
          fornecedor_nome: r.fornecedor_nome,
          classe_consolidada: r.classe_consolidada,
          saldo, cmc, capital_parado: capital,
          dias_sem_vender: dias,
          demanda_media_diaria: r.demanda_media_diaria,
          valor_vendido_90d: r.valor_vendido_90d,
          status_sugestao: status,
          situacao_tipo: sit.tipo, situacao_label: sit.label, situacao_cta: sit.cta,
          estoque_minimo: r.estoque_minimo, ponto_pedido: r.ponto_pedido, estoque_maximo: r.estoque_maximo,
          habilitado_reposicao_automatica: r.habilitado_reposicao_automatica,
          tipo_reposicao: r.tipo_reposicao,
          vendas_registradas: vendasRegistradas,
          giro_morto: ehGiroMorto({ diasSemVender: dias, vendasRegistradas, emColdStart }),
        };
      });
    },
  });

  const qc = useQueryClient();

  const manterEmEstoque = useMutation({
    mutationFn: async (args: { codes: number[]; min: number; ponto: number; max: number }) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update({
          estoque_minimo: args.min,
          ponto_pedido: args.ponto,
          estoque_maximo: args.max,
          habilitado_reposicao_automatica: true,
          tipo_reposicao: "automatica",
        })
        .eq("empresa", empresa)
        .in("sku_codigo_omie", args.codes);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(`${vars.codes.length} item(ns) com estoque mínimo definido`);
      qc.invalidateQueries({ queryKey: ["reposicao-baixo-giro"] });
    },
    onError: (e: Error) => toast.error("Falha ao salvar: " + e.message),
  });

  const descontinuar = useMutation({
    mutationFn: async (code: number) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update({ tipo_reposicao: "descontinuado", habilitado_reposicao_automatica: false })
        .eq("empresa", empresa)
        .eq("sku_codigo_omie", code);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("SKU descontinuado — fora dos próximos ciclos");
      qc.invalidateQueries({ queryKey: ["reposicao-baixo-giro"] });
      qc.invalidateQueries({ queryKey: ["reposicao-excesso-estoque"] });
      qc.invalidateQueries({ queryKey: ["pedidos-ciclo"] });
    },
    onError: (e: Error) => toast.error("Falha ao descontinuar: " + e.message),
  });

  // P3 — descontinuar em LOTE (giro morto): mesma escrita do individual, com o founder confirmando
  // a lista no AlertDialog (gate humano preservado; a seleção é dele, não do sistema).
  const descontinuarLote = useMutation({
    mutationFn: async (codes: number[]) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update({ tipo_reposicao: "descontinuado", habilitado_reposicao_automatica: false })
        .eq("empresa", empresa)
        .in("sku_codigo_omie", codes);
      if (error) throw error;
    },
    onSuccess: (_d, codes) => {
      toast.success(`${codes.length} SKU(s) descontinuado(s) — fora dos próximos ciclos`);
      qc.invalidateQueries({ queryKey: ["reposicao-baixo-giro"] });
      qc.invalidateQueries({ queryKey: ["reposicao-excesso-estoque"] });
      qc.invalidateQueries({ queryKey: ["pedidos-ciclo"] });
    },
    onError: (e: Error) => toast.error("Falha ao descontinuar em lote: " + e.message),
  });

  const kpis = useMemo(() => {
    const rows = query.data ?? [];
    const cap = somarCapitalParado(rows.map((r) => ({ saldo: r.saldo, cmc: r.cmc })));
    const morto = somarCapitalMorto(rows.map((r) => ({ giroMorto: r.giro_morto, saldo: r.saldo, cmc: r.cmc })));
    return { ...cap, totalItens: rows.length, morto };
  }, [query.data]);

  return { rows: query.data ?? [], kpis, isLoading: query.isLoading, error: query.error, refetch: query.refetch, manterEmEstoque, descontinuar, descontinuarLote };
}
