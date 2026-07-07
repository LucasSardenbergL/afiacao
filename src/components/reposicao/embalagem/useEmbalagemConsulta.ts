// Hook da tela avulsa de consulta de embalagem econômica (compra manual).
// Carrega TODOS os grupos de equivalência ativos da empresa (não filtra por pedido)
// + preços + descrição + demanda/cm, pra a página rodar o helper com a necessidade
// que o usuário digita. Espelha o carregamento do useEmbalagemPedido, sem o acoplamento
// aos itens de um pedido sugerido.
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { StatusPreco } from '@/lib/reposicao/embalagem-helpers';

interface EquivRow { grupo_id: string; sku_codigo_omie: string; unidade_base: string; fator_para_base: number; }
interface PrecoRow { sku_codigo_omie: string; preco: number; capturado_em: string; status: StatusPreco; }

interface MembroEmbalagem {
  sku_codigo_omie: string;
  fator_para_base: number;            // QT=1, GL=4
  preco: number | null;
  preco_status: StatusPreco | null;
  descricao: string;                  // descrição do Omie (fallback = código)
  capturado_em: string | null;
}

export interface GrupoEmbalagem {
  grupo_id: string;
  unidade_base: string;
  titulo: string;
  membros: MembroEmbalagem[];         // ordenado por fator ascendente
  demanda_base: number | null;        // soma da demanda dos membros convertida p/ unidade-base
  custo_capital_anual: number;        // decimal (0 quando indisponível)
  cm_disponivel: boolean;
}

export interface EmbalagemConsultaResult {
  grupos: GrupoEmbalagem[];
  limiar: number;
  isLoading: boolean;
  isError: boolean;
}

export function useEmbalagemConsulta(empresa: string): EmbalagemConsultaResult {
  const emp = (empresa ?? '').toLowerCase();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['embalagem-consulta', emp],
    enabled: !!emp,
    queryFn: async (): Promise<{ grupos: GrupoEmbalagem[]; limiar: number }> => {
      // 1) Todos os grupos ativos da empresa
      const equivResp = await supabase
        .from('sku_embalagem_equivalencia' as never)
        .select('grupo_id, sku_codigo_omie, unidade_base, fator_para_base')
        .eq('empresa', emp)
        .eq('ativo', true);
      if (equivResp.error) throw equivResp.error; // money-path: não degradar silencioso
      const equiv = (equivResp.data ?? []) as unknown as EquivRow[];
      if (equiv.length === 0) return { grupos: [], limiar: 5 };

      const skusGrupo = [...new Set(equiv.map((e) => e.sku_codigo_omie))];
      const skuNums = skusGrupo.map(Number).filter((n) => Number.isFinite(n));

      // 2) Preço mais recente por SKU
      const precoResp = await supabase
        .from('sku_preco_fornecedor_capturado' as never)
        .select('sku_codigo_omie, preco, capturado_em, status')
        .eq('empresa', emp)
        .in('sku_codigo_omie', skusGrupo)
        .order('capturado_em', { ascending: false });
      if (precoResp.error) throw precoResp.error;
      const precoRows = (precoResp.data ?? []) as unknown as PrecoRow[];
      const precoMap = new Map<string, PrecoRow>();
      for (const p of precoRows) {
        const k = String(p.sku_codigo_omie);
        if (!precoMap.has(k)) precoMap.set(k, p);
      }

      // 3) Descrição (omie_products) — rótulo legível por SKU
      const descMap = new Map<string, string>();
      if (skuNums.length > 0) {
        const prodResp = await supabase
          .from('omie_products')
          .select('omie_codigo_produto, descricao')
          .in('omie_codigo_produto', skuNums);
        ((prodResp.data ?? []) as unknown as { omie_codigo_produto: number | string; descricao: string | null }[])
          .forEach((p) => {
            const k = String(p.omie_codigo_produto);
            if (p.descricao && !descMap.has(k)) descMap.set(k, p.descricao);
          });
      }

      // 4) Demanda + custo de capital (robustez; itens fora do motor → null/0)
      const demandaMap = new Map<string, number | null>();
      const cmMap = new Map<string, number | null>();
      if (skuNums.length > 0) {
        const paramResp = await supabase
          .from('sku_parametros')
          .select('sku_codigo_omie, demanda_media_diaria')
          .eq('empresa', emp)
          .in('sku_codigo_omie', skuNums);
        ((paramResp.data ?? []) as unknown as { sku_codigo_omie: number; demanda_media_diaria: number | null }[])
          .forEach((p) => demandaMap.set(String(p.sku_codigo_omie), p.demanda_media_diaria));

        const cmResp = await supabase
          .from('v_sku_parametros_sugeridos')
          .select('sku_codigo_omie, custo_capital_efetivo_perc')
          .eq('empresa', emp)
          .in('sku_codigo_omie', skuNums);
        ((cmResp.data ?? []) as unknown as { sku_codigo_omie: number; custo_capital_efetivo_perc: number | null }[])
          .forEach((p) => cmMap.set(String(p.sku_codigo_omie), p.custo_capital_efetivo_perc));
      }

      // 5) Config (limiar de economia + janela de stale)
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

      // 6) Montar grupos (>= 2 membros)
      const porGrupo = new Map<string, EquivRow[]>();
      for (const e of equiv) {
        const a = porGrupo.get(e.grupo_id) ?? [];
        a.push(e);
        porGrupo.set(e.grupo_id, a);
      }

      const grupos: GrupoEmbalagem[] = [];
      for (const [grupo_id, membrosRaw] of porGrupo) {
        if (membrosRaw.length < 2) continue; // grupo de 1 → sem decisão de embalagem
        const membrosOrd = [...membrosRaw].sort((a, b) => Number(a.fator_para_base) - Number(b.fator_para_base));
        const membros: MembroEmbalagem[] = membrosOrd.map((m) => {
          const p = precoMap.get(m.sku_codigo_omie);
          return {
            sku_codigo_omie: m.sku_codigo_omie,
            fator_para_base: Number(m.fator_para_base),
            preco: p ? Number(p.preco) : null,
            preco_status: statusComStale(p),
            descricao: descMap.get(m.sku_codigo_omie) ?? m.sku_codigo_omie,
            capturado_em: p?.capturado_em ?? null,
          };
        });
        // Demanda do conteúdo = soma das demandas dos membros convertidas p/ unidade-base.
        let demanda_base: number | null = null;
        for (const m of membros) {
          const dm = demandaMap.get(m.sku_codigo_omie);
          if (dm != null) demanda_base = (demanda_base ?? 0) + dm * m.fator_para_base;
        }
        const cmRaw = membros.map((m) => cmMap.get(m.sku_codigo_omie)).find((v) => v != null && Number(v) > 0);
        const cm_disponivel = cmRaw != null;
        grupos.push({
          grupo_id,
          unidade_base: membrosOrd[0].unidade_base,
          titulo: descMap.get(membrosOrd[0].sku_codigo_omie) ?? `Grupo ${grupo_id.slice(0, 8)}`,
          membros,
          demanda_base,
          custo_capital_anual: cm_disponivel ? Number(cmRaw) / 100 : 0,
          cm_disponivel,
        });
      }
      grupos.sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
      return { grupos, limiar };
    },
  });

  return { grupos: data?.grupos ?? [], limiar: data?.limiar ?? 5, isLoading, isError };
}
