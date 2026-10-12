// Entrada "Pedir por cor" (Fase 2A): cor → produto/acabamento → embalagem, derivando a
// base. É a busca global de cor rodando SEM base escolhida (o seletor por base segue igual).
// Preço: o MESMO motor batch (`get_tint_prices`) das outras embalagens, fail-closed.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { imatchTokensSemAcento } from '@/lib/postgrest';
import { useTintPrices } from '@/hooks/useTintPricing';
import type { AltPriceSource } from '@/lib/tint/select-price';
import type { AlternativePackaging } from './types';

// Tipo pelo contrato local — importar de vendas seria aresta nova tintometrico→vendas.
type Product = AlternativePackaging['product'];

export interface CorEncontrada {
  corId: string;
  nomeCor: string;
}

export interface EmbalagemDaCor extends AlternativePackaging {
  /** Produto/acabamento (tint_produtos) — o cabeçalho do grupo. */
  grupo: string;
  /** Volume da embalagem, para ordenar dentro do grupo (null = sem cadastro). */
  volumeMl: number | null;
}

/** Linhas da canônica por página (capa do PostgREST). Cada cor tem ~64 SKUs (p50=p95,
 *  medido 2026-10-11), então 1 página traz ~15 cores — o resto pede busca mais precisa. */
const LINHAS_BUSCA = 1000;

/** Dedup cor_id → 1 entrada (a canônica traz 1 linha por SKU da cor). Puro. */
export function coresDistintas(linhas: { cor_id: string | null; nome_cor: string | null }[]): CorEncontrada[] {
  const vistas = new Map<string, CorEncontrada>();
  for (const l of linhas) {
    if (!l.cor_id || !l.nome_cor || vistas.has(l.cor_id)) continue;
    vistas.set(l.cor_id, { corId: l.cor_id, nomeCor: l.nome_cor });
  }
  return [...vistas.values()];
}

export function useCorPrimeiro(open: boolean) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [cor, setCor] = useState<CorEncontrada | null>(null);
  const [overrides, setOverrides] = useState<Record<string, AltPriceSource>>({});
  const [descontos, setDescontos] = useState<Record<string, number>>({});

  // Desconto e fonte são escolha POR ITEM (Fase 3, Codex P1): nunca sobrevivem a fechar o
  // diálogo nem a trocar de cor.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setDebouncedSearch('');
      setCor(null);
    }
  }, [open]);
  useEffect(() => {
    setOverrides({});
    setDescontos({});
  }, [cor?.corId, open]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const {
    data: busca,
    isLoading: loadingCores,
    isError: coresErro,
    refetch: refetchCores,
  } = useQuery({
    queryKey: ['tint-cor-primeiro-cores', debouncedSearch],
    staleTime: 5 * 60 * 1000,
    enabled: open && debouncedSearch.length >= 2,
    queryFn: async (): Promise<{ cores: CorEncontrada[]; truncado: boolean }> => {
      const palavras = imatchTokensSemAcento(['cor_id', 'nome_cor'], debouncedSearch);
      if (palavras.length === 0) return { cores: [], truncado: false };
      let q = supabase.from('v_tint_formula_canonica').select('cor_id, nome_cor').eq('account', 'oben');
      for (const p of palavras) q = q.or(p);
      // Erro LANÇA: lista vazia mentiria "cor não encontrada".
      const { data, error } = await q
        .order('cor_id', { ascending: true })
        .order('id', { ascending: true })
        .limit(LINHAS_BUSCA);
      if (error) throw error;
      const linhas = data ?? [];
      const cores = coresDistintas(linhas);
      // Página cheia ⇒ a ÚLTIMA cor pode ter vindo pela metade e há mais cores depois:
      // descarta a última (não mostra cor com embalagens faltando) e avisa.
      const truncado = linhas.length >= LINHAS_BUSCA;
      return { cores: truncado && cores.length > 1 ? cores.slice(0, -1) : cores, truncado };
    },
  });

  const {
    data: embalagens,
    isLoading: loadingEmbalagens,
    isError: embalagensErro,
    refetch: refetchEmbalagens,
  } = useQuery({
    queryKey: ['tint-cor-primeiro-embalagens', cor?.corId],
    staleTime: 5 * 60 * 1000,
    enabled: open && !!cor,
    queryFn: async (): Promise<EmbalagemDaCor[]> => {
      const { data: formulas, error: fErr } = await supabase
        .from('v_tint_formula_canonica')
        .select('id, sku_id, preco_csv_legado, is_sl')
        .eq('account', 'oben')
        .eq('cor_id', cor!.corId)
        .order('id', { ascending: true });
      if (fErr) throw fErr;
      const fs = (formulas ?? []).filter(
        (f): f is typeof f & { id: string; sku_id: string } => f.id != null && f.sku_id != null,
      );
      if (fs.length === 0) return [];

      const { data: skus, error: sErr } = await supabase
        .from('tint_skus')
        .select('id, omie_product_id, produto_id, embalagem_id')
        .in('id', [...new Set(fs.map((f) => f.sku_id))])
        .not('omie_product_id', 'is', null);
      if (sErr) throw sErr;
      if (!skus || skus.length === 0) return [];

      const produtoIds = [...new Set(skus.map((s) => s.produto_id).filter(Boolean))];
      const embalagemIds = [...new Set(skus.map((s) => s.embalagem_id).filter((x): x is string => !!x))];
      const [produtosR, embalagensR, omieR] = await Promise.all([
        supabase.from('tint_produtos').select('id, descricao').in('id', produtoIds),
        embalagemIds.length > 0
          ? supabase.from('tint_embalagens').select('id, volume_ml').in('id', embalagemIds)
          : Promise.resolve({ data: [] as { id: string; volume_ml: number | null }[], error: null }),
        supabase
          .from('omie_products')
          .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type')
          // money-path: não oferecer produto-base desativado no Omie (UX; o gate final é no submit)
          .eq('ativo', true)
          // Codex P1 (rodada 2): só base tintométrica DA OBEN — um vínculo errado para produto
          // Colacor/comum iria ao carrinho sem os metadados que o gate tint revalida.
          .eq('account', 'oben')
          .eq('is_tintometric', true)
          .eq('tint_type', 'base')
          .in('id', skus.map((s) => s.omie_product_id!)),
      ]);
      if (produtosR.error) throw produtosR.error;
      if (embalagensR.error) throw embalagensR.error;
      if (omieR.error) throw omieR.error;

      const produtoDesc = new Map((produtosR.data ?? []).map((p) => [p.id, p.descricao]));
      const volume = new Map((embalagensR.data ?? []).map((e) => [e.id, e.volume_ml]));
      const omie = new Map((omieR.data ?? []).map((p) => [p.id, p]));
      const skuPorId = new Map(skus.map((s) => [s.id, s]));

      const out: EmbalagemDaCor[] = [];
      for (const f of fs) {
        const sku = skuPorId.get(f.sku_id);
        const prod = sku?.omie_product_id ? omie.get(sku.omie_product_id) : undefined;
        if (!sku || !prod) continue;
        out.push({
          formulaId: f.id,
          skuId: f.sku_id,
          omieProductId: prod.id,
          productDescricao: prod.descricao,
          productCodigo: prod.codigo,
          precoFinalCsv: f.preco_csv_legado ? Math.ceil(f.preco_csv_legado * 10) / 10 : f.preco_csv_legado,
          product: prod as Product,
          sameAcabamento: false,
          corId: cor!.corId,
          nomeCor: cor!.nomeCor,
          isSl: f.is_sl,
          grupo: produtoDesc.get(sku.produto_id) ?? 'Outros',
          volumeMl: sku.embalagem_id ? volume.get(sku.embalagem_id) ?? null : null,
        });
      }
      out.sort(
        (a, b) =>
          a.grupo.localeCompare(b.grupo) ||
          (a.volumeMl ?? Infinity) - (b.volumeMl ?? Infinity) ||
          a.productDescricao.localeCompare(b.productDescricao),
      );
      return out;
    },
  });

  const formulaIds = useMemo(() => (embalagens ?? []).map((e) => e.formulaId), [embalagens]);
  const {
    data: precosBrutos,
    isLoading: precoQueryLoading,
    isError: precoErro,
    isFetching: precoFetching,
    refetch: refetchPrecos,
  } = useTintPrices(formulaIds);
  // Refazendo após erro conta como carregando ("calculando", não "sem preço").
  const precoCarregando = formulaIds.length > 0 && (precoQueryLoading || (precoErro && precoFetching));
  // Fail-closed (Codex P1 da Fase 1): após erro o React Query mantém o mapa velho —
  // com erro ou recarregando, nenhum preço é confirmável.
  const precos = precoErro || precoCarregando ? undefined : precosBrutos;

  const falhaLeitura = coresErro || embalagensErro;
  const tentarDeNovo = () => {
    if (coresErro) void refetchCores();
    if (embalagensErro) void refetchEmbalagens();
    if (precoErro) void refetchPrecos();
  };

  return {
    search,
    buscaEstavel: search === debouncedSearch,
    onSearchChange: (v: string) => {
      setSearch(v);
      setCor(null);
    },
    cores: busca?.cores,
    truncado: busca?.truncado ?? false,
    loadingCores: open && debouncedSearch.length >= 2 && loadingCores,
    cor,
    setCor,
    embalagens,
    loadingEmbalagens: !!cor && loadingEmbalagens,
    precos,
    precoCarregando,
    precoErro: precoErro && !precoCarregando,
    overrides,
    setOverride: (formulaId: string, source: AltPriceSource) =>
      setOverrides((prev) => ({ ...prev, [formulaId]: source })),
    descontos,
    setDesconto: (formulaId: string, pct: number) =>
      setDescontos((prev) => ({ ...prev, [formulaId]: Math.min(99.99, Math.max(0, pct)) })),
    falhaLeitura,
    tentarDeNovo,
  };
}
