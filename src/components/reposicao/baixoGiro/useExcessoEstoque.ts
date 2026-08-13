import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useReposicaoEmpresa } from "@/contexts/ReposicaoEmpresaContext";
import { fetchAllPages } from "@/lib/postgrest";
import { diasSemVender } from "@/lib/reposicao/baixo-giro-helpers";
import {
  accountsDaEmpresa,
  calcularLinhaExcesso,
  dedupePosicaoMaisRecente,
  ordenarPorCapitalExcedente,
  somarKpisExcesso,
  type PosicaoEstoque,
  type SituacaoExcesso,
} from "@/lib/reposicao/excesso-helpers";
import type { RowExcesso } from "./types";

const HOJE_ISO = () => new Date().toISOString().slice(0, 10);

interface ParamRow {
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  classe_consolidada: string | null;
  demanda_media_diaria: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  habilitado_reposicao_automatica: boolean | null;
  tipo_reposicao: string | null;
}

/**
 * Fila de desova — SKUs com estoque ACIMA do `estoque_maximo` da política.
 * Universo: TODO sku_parametros ativo com máximo definido (inclusive reposição desabilitada —
 * capital em excesso é capital, esteja o SKU comprável ou não). Saldo pelo padrão canônico do
 * motor: accounts da empresa, linha mais recente por SKU.
 */
export function useExcessoEstoque() {
  const { empresa } = useReposicaoEmpresa();

  const query = useQuery({
    queryKey: ["reposicao-excesso-estoque", empresa],
    staleTime: 60_000,
    queryFn: async (): Promise<RowExcesso[]> => {
      const params = await fetchAllPages<ParamRow>(
        (de, ate) =>
          supabase
            .from("sku_parametros")
            .select("sku_codigo_omie, sku_descricao, fornecedor_nome, classe_consolidada, demanda_media_diaria, ponto_pedido, estoque_maximo, habilitado_reposicao_automatica, tipo_reposicao")
            .eq("empresa", empresa)
            .eq("ativo", true)
            .not("estoque_maximo", "is", null)
            .order("sku_codigo_omie", { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ParamRow[] | null; error: unknown }>,
        "sku_parametros/excesso",
      );
      const codes = params.map((r) => Number(r.sku_codigo_omie));
      if (codes.length === 0) return [];

      const [posicoes, demandas] = await Promise.all([
        fetchAllPages<PosicaoEstoque>(
          (de, ate) =>
            supabase
              .from("inventory_position")
              .select("omie_codigo_produto, saldo, cmc, synced_at")
              .in("account", accountsDaEmpresa(empresa))
              .in("omie_codigo_produto", codes)
              .order("id", { ascending: true })
              .range(de, ate) as unknown as PromiseLike<{ data: PosicaoEstoque[] | null; error: unknown }>,
          "inventory_position/excesso",
        ),
        fetchAllPages<{ sku_codigo_omie: number; ultima_venda_data: string | null }>(
          (de, ate) =>
            supabase
              .from("v_sku_demanda_estatisticas")
              .select("sku_codigo_omie, ultima_venda_data")
              .eq("empresa", empresa)
              .in("sku_codigo_omie", codes)
              .order("sku_codigo_omie", { ascending: true })
              .range(de, ate) as unknown as PromiseLike<{ data: { sku_codigo_omie: number; ultima_venda_data: string | null }[] | null; error: unknown }>,
          "v_sku_demanda_estatisticas/excesso",
        ),
      ]);

      const posMap = dedupePosicaoMaisRecente(
        posicoes.map((p) => ({ ...p, omie_codigo_produto: Number(p.omie_codigo_produto) })),
      );
      const demMap = new Map(demandas.map((d) => [Number(d.sku_codigo_omie), d.ultima_venda_data]));
      const hoje = HOJE_ISO();

      const rows: RowExcesso[] = [];
      for (const p of params) {
        const code = Number(p.sku_codigo_omie);
        const pos = posMap.get(code);
        const linha = calcularLinhaExcesso({
          saldo: pos?.saldo ?? null,
          estoqueMaximo: p.estoque_maximo,
          demandaMediaDiaria: p.demanda_media_diaria,
          cmc: pos?.cmc ?? null,
        });
        if (!linha) continue;
        rows.push({
          id: String(code),
          sku_codigo_omie: code,
          sku_descricao: p.sku_descricao,
          fornecedor_nome: p.fornecedor_nome,
          classe_consolidada: p.classe_consolidada,
          saldo: pos?.saldo ?? null,
          cmc: pos?.cmc ?? null,
          ponto_pedido: p.ponto_pedido,
          estoque_maximo: p.estoque_maximo,
          excedente_un: linha.excedenteUn,
          capital_excedente: linha.capitalExcedente,
          tempo_digerir_dias: linha.tempoDigerirDias,
          situacao_excesso: linha.situacao,
          demanda_media_diaria: p.demanda_media_diaria,
          dias_sem_vender: diasSemVender(demMap.get(code) ?? null, hoje),
          habilitado_reposicao_automatica: p.habilitado_reposicao_automatica,
          tipo_reposicao: p.tipo_reposicao,
        });
      }
      return ordenarPorCapitalExcedente(rows, (r) => r.capital_excedente);
    },
  });

  const kpis = useMemo(
    () =>
      somarKpisExcesso(
        (query.data ?? []).map((r) => ({
          capitalExcedente: r.capital_excedente,
          situacao: r.situacao_excesso as SituacaoExcesso,
        })),
      ),
    [query.data],
  );

  return { rows: query.data ?? [], kpis, isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}
