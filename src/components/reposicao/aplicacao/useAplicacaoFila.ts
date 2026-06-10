// Lógica da tela de aplicação no Omie (fila, contadores, mutations).
// Extraída verbatim de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  EMPRESA,
  type FilaItem,
  type GerarFilaResult,
} from "./types";

export function useAplicacaoFila() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("pronto");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deltaFilter, setDeltaFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [substituicaoOpen, setSubstituicaoOpen] = useState<FilaItem | null>(null);
  const [confirmLote, setConfirmLote] = useState<{ ids: number[]; maxDelta: number } | null>(null);
  const [confirmIndividual, setConfirmIndividual] = useState<FilaItem | null>(null);

  // Última sincronização Omie
  const { data: ultimoSync } = useQuery({
    queryKey: ["sku-status-omie-ultimo-sync", EMPRESA],
    queryFn: async () => {
      const { data } = await supabase
        .from("sku_status_omie")
        .select("ultima_sincronizacao")
        .eq("empresa", EMPRESA)
        .order("ultima_sincronizacao", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.ultima_sincronizacao ?? null;
    },
    refetchInterval: 60000,
  });

  // Contadores de cada aba — head-counts server-side. A versão anterior
  // baixava TODAS as linhas da fila (o histórico de aplicado_em acumula sem
  // corte de data) a cada 30s só pra somar 4 números no client.
  const { data: contadores } = useQuery({
    queryKey: ["fila-aplicacao-contadores", EMPRESA],
    queryFn: async () => {
      const base = () =>
        supabase
          .from("fila_aplicacao_omie" as never)
          .select("id", { count: "exact", head: true })
          .eq("empresa", EMPRESA);
      const [pronto, inativo, substituicao, aplicado] = (await Promise.all([
        base().eq("status_validacao", "pronto").is("aplicado_em", null),
        base().eq("status_validacao", "bloqueado_inativo").is("aplicado_em", null),
        base().eq("status_validacao", "bloqueado_substituicao").is("aplicado_em", null),
        base().not("aplicado_em", "is", null),
      ])) as unknown as Array<{ count: number | null }>;
      return {
        pronto: pronto.count ?? 0,
        inativo: inativo.count ?? 0,
        substituicao: substituicao.count ?? 0,
        aplicado: aplicado.count ?? 0,
      };
    },
    refetchInterval: 60000,
  });

  // Listagens por aba
  const { data: itens, isLoading } = useQuery({
    queryKey: ["fila-aplicacao", EMPRESA, tab],
    queryFn: async () => {
      // Builder genérico — tabela ainda fora do Database type, cast de retorno.
      let q = supabase
        .from("fila_aplicacao_omie" as never)
        .select("*")
        .eq("empresa", EMPRESA);
      if (tab === "pronto") q = q.eq("status_validacao", "pronto").is("aplicado_em", null);
      else if (tab === "inativo")
        q = q.eq("status_validacao", "bloqueado_inativo").is("aplicado_em", null);
      else if (tab === "substituicao")
        q = q.eq("status_validacao", "bloqueado_substituicao").is("aplicado_em", null);
      else if (tab === "aplicado")
        q = q
          .not("aplicado_em", "is", null)
          .gte("aplicado_em", new Date(Date.now() - 30 * 86400000).toISOString())
          .order("aplicado_em", { ascending: false });
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as FilaItem[];
    },
    // 60s em todas as abas: o feedback imediato pós-ação vem do invalidateFila
    // das mutations — o poll é só rede de segurança (antes 15s = 4 requests
    // `select *` por minuto enquanto o comprador trabalhava na aba).
    refetchInterval: 60000,
  });

  // Filtros adicionais (delta + busca) somente na aba "pronto"
  const filteredItens = useMemo(() => {
    if (!itens) return [];
    let arr = itens;
    if (search.trim()) {
      const s = search.toLowerCase();
      arr = arr.filter(
        (i) =>
          i.sku_codigo_omie.toLowerCase().includes(s) ||
          (i.sku_descricao ?? "").toLowerCase().includes(s)
      );
    }
    if (tab === "pronto" && deltaFilter !== "all") {
      arr = arr.filter((i) => {
        const d = i.delta_max_perc ?? 0;
        if (deltaFilter === "<10") return d < 10;
        if (deltaFilter === "10-25") return d >= 10 && d < 25;
        if (deltaFilter === "25-50") return d >= 25 && d < 50;
        if (deltaFilter === ">50") return d >= 50;
        return true;
      });
    }
    return arr;
  }, [itens, search, deltaFilter, tab]);

  const hasBloqueados = (contadores?.inativo ?? 0) + (contadores?.substituicao ?? 0) > 0;
  const syncDesatualizado =
    !ultimoSync || Date.now() - new Date(ultimoSync).getTime() > 24 * 3600 * 1000;

  // Mutations
  const gerarFila = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("gerar_fila_aplicacao_omie" as never, {
        p_empresa: EMPRESA,
      } as never);
      if (error) throw error;
      return data as unknown as GerarFilaResult | GerarFilaResult[];
    },
    onSuccess: (data) => {
      const r = (Array.isArray(data) ? data[0] : data) as GerarFilaResult | undefined;
      toast.success(
        `Fila gerada: ${r?.prontos ?? 0} prontos, ${r?.bloqueados_inativos ?? 0} inativos, ${
          r?.bloqueados_substituicao ?? 0
        } com substituição`
      );
      qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
      qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
    },
    onError: (e: Error) => toast.error("Falha ao gerar fila: " + e.message),
  });

  const sincronizarOmie = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("omie-sync-status-produtos", {
        body: { empresa: EMPRESA },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Sincronização Omie disparada");
      qc.invalidateQueries({ queryKey: ["sku-status-omie-ultimo-sync"] });
    },
    onError: (e: Error) => toast.error("Falha no sync: " + e.message),
  });

  const aplicarIds = useMutation({
    mutationFn: async (ids: number[]) => {
      const { data, error } = await supabase.functions.invoke("omie-aplicar-parametros", {
        body: { empresa: EMPRESA, ids },
      });
      if (error) throw error;
      return data as { sucessos: number; falhas: number };
    },
    onSuccess: (r) => {
      toast.success(`Aplicados: ${r.sucessos} | Falhas: ${r.falhas}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
      qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
    },
    onError: (e: Error) => toast.error("Falha ao aplicar: " + e.message),
  });

  const desativarSku = useMutation({
    mutationFn: async (sku: string) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update({ aplicar_no_omie: false })
        .eq("empresa", EMPRESA)
        .eq("sku_codigo_omie", Number(sku));
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("SKU descadastrado do módulo");
      qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
      qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
    },
  });

  const handleAplicarLote = (ids: number[]) => {
    if (hasBloqueados) {
      toast.error("Resolva primeiro os SKUs bloqueados antes de aplicar em lote.");
      return;
    }
    const itensSel = (filteredItens ?? []).filter((i) => ids.includes(i.id));
    const maxDelta = Math.max(0, ...itensSel.map((i) => i.delta_max_perc ?? 0));
    if (maxDelta > 50) {
      setConfirmLote({ ids, maxDelta });
      return;
    }
    aplicarIds.mutate(ids);
  };

  const toggleAll = () => {
    if (selected.size === filteredItens.length) setSelected(new Set());
    else setSelected(new Set(filteredItens.map((i) => i.id)));
  };

  const invalidateFila = () => {
    qc.invalidateQueries({ queryKey: ["fila-aplicacao"] });
    qc.invalidateQueries({ queryKey: ["fila-aplicacao-contadores"] });
  };

  return {
    tab,
    setTab,
    selected,
    setSelected,
    deltaFilter,
    setDeltaFilter,
    search,
    setSearch,
    substituicaoOpen,
    setSubstituicaoOpen,
    confirmLote,
    setConfirmLote,
    confirmIndividual,
    setConfirmIndividual,
    ultimoSync,
    contadores,
    isLoading,
    filteredItens,
    hasBloqueados,
    syncDesatualizado,
    gerarFila,
    sincronizarOmie,
    aplicarIds,
    desativarSku,
    handleAplicarLote,
    toggleAll,
    invalidateFila,
  };
}
