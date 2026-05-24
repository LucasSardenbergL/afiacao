// Lógica da tela de cadeia logística (queries, mutations, recálculo de LT com impacto).
// Extraída verbatim de src/pages/AdminReposicaoCadeiaLogistica.tsx (god-component split).
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Etapa, Fornecedor, HistoricoItem } from "./types";
import { EMPRESA } from "./shared";

export function useCadeiaLogistica() {
  const { isAdmin } = useAuth();
  const podeEditar = isAdmin;
  const qc = useQueryClient();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editandoEtapa, setEditandoEtapa] = useState<Etapa | null>(null);
  const [novaEtapaForn, setNovaEtapaForn] = useState<string | null>(null);
  const [trocandoParceiro, setTrocandoParceiro] = useState<Etapa | null>(null);

  // Fornecedores habilitados
  const { data: fornecedores, isLoading: loadingForn } = useQuery({
    queryKey: ["cadeia-fornecedores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_habilitado_reposicao")
        .select("empresa, fornecedor_nome, habilitado")
        .eq("habilitado", true)
        .order("fornecedor_nome");
      if (error) throw error;
      return (data ?? []) as Fornecedor[];
    },
  });

  // Etapas
  const { data: etapas, isLoading: loadingEt } = useQuery({
    queryKey: ["cadeia-etapas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_cadeia_logistica")
        .select("*")
        .order("fornecedor_nome")
        .order("ordem");
      if (error) throw error;
      return (data ?? []) as Etapa[];
    },
  });

  // Histórico
  const { data: historico } = useQuery({
    queryKey: ["cadeia-historico"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_cadeia_logistica_historico")
        .select("*")
        .order("criado_em", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as HistoricoItem[];
    },
  });

  // Calcular LT total antes de mudança (para mensurar impacto)
  async function ltTotalAtualForn(fornecedor: string): Promise<number> {
    const { data } = await supabase
      .from("fornecedor_cadeia_logistica")
      .select("lt_dias")
      .eq("empresa", EMPRESA)
      .eq("fornecedor_nome", fornecedor)
      .eq("ativo", true);
    return ((data ?? []) as Array<{ lt_dias: number | string | null }>).reduce(
      (s, r) => s + (Number(r.lt_dias) || 0),
      0,
    );
  }

  // Recalcular parâmetros + log + toast com impacto
  async function recalcularComImpacto(args: {
    fornecedor: string;
    ltAntes: number;
    acao: string;
    descricao: string;
    etapa_codigo?: string | null;
    valoresAnt?: Record<string, unknown> | Etapa | null;
    valoresNov?: Record<string, unknown> | Partial<Etapa> | null;
  }) {
    try {
      const ltDepois = await ltTotalAtualForn(args.fornecedor);
      const delta = ltDepois - args.ltAntes;

      // log histórico — coluna `empresa` existe no DB mas ainda não no generated type
      await supabase.from("fornecedor_cadeia_logistica_historico").insert({
        empresa: EMPRESA,
        fornecedor_nome: args.fornecedor,
        etapa_codigo: args.etapa_codigo ?? null,
        acao: args.acao,
        descricao_mudanca: args.descricao,
        valores_anteriores: args.valoresAnt ?? null,
        valores_novos: args.valoresNov ?? null,
      } as never);

      // chamar recálculo (best-effort)
      const { error: rpcErr } = await supabase.rpc(
        "atualizar_parametros_numericos_skus",
        { p_empresa: EMPRESA },
      );
      if (rpcErr) {
        console.warn("Recalc falhou:", rpcErr);
      }

      const sinal = delta > 0 ? "+" : "";
      const msg =
        delta === 0
          ? "LT teórico inalterado."
          : `LT teórico recalculado (${sinal}${delta} dias úteis). Capital de giro pode variar proporcionalmente.`;
      toast.success(msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.warning(`Mudança salva mas recálculo falhou: ${msg}`);
    }
  }

  // Salvar etapa (criar/editar)
  const salvarEtapaMut = useMutation({
    mutationFn: async (payload: {
      modo: "criar" | "editar";
      fornecedor: string;
      etapa: Partial<Etapa>;
      etapaOriginal?: Etapa;
    }) => {
      const ltAntes = await ltTotalAtualForn(payload.fornecedor);

      if (payload.modo === "criar") {
        // Calcular próxima ordem
        const ordensExist = (etapas ?? [])
          .filter(
            (e) => e.empresa === EMPRESA && e.fornecedor_nome === payload.fornecedor,
          )
          .map((e) => e.ordem);
        const proxOrdem = ordensExist.length > 0 ? Math.max(...ordensExist) + 1 : 1;
        const codigo = `${payload.fornecedor.slice(0, 4).toUpperCase().replace(/\s/g, "")}_E${proxOrdem}_${Date.now().toString(36)}`;

        // `empresa` field existe no DB mas ainda não no generated type
        const { error } = await supabase
          .from("fornecedor_cadeia_logistica")
          .insert({
            empresa: EMPRESA,
            fornecedor_nome: payload.fornecedor,
            ordem: proxOrdem,
            etapa_codigo: codigo,
            descricao: payload.etapa.descricao,
            lt_dias: payload.etapa.lt_dias,
            lt_unidade: payload.etapa.lt_unidade ?? "uteis",
            parceiro_nome: payload.etapa.parceiro_nome ?? null,
            parceiro_tipo: payload.etapa.parceiro_tipo ?? null,
            parceiro_contato: payload.etapa.parceiro_contato ?? null,
            observacoes: payload.etapa.observacoes ?? null,
            ativo: true,
          } as never);
        if (error) throw error;

        await recalcularComImpacto({
          fornecedor: payload.fornecedor,
          ltAntes,
          acao: "criacao",
          descricao: `Nova etapa "${payload.etapa.descricao}" adicionada (${payload.etapa.lt_dias} dias)`,
          etapa_codigo: codigo,
          valoresNov: payload.etapa,
        });
      } else if (payload.etapaOriginal) {
        const orig = payload.etapaOriginal;
        const { error } = await supabase
          .from("fornecedor_cadeia_logistica")
          .update({
            descricao: payload.etapa.descricao,
            lt_dias: payload.etapa.lt_dias,
            lt_unidade: payload.etapa.lt_unidade,
            parceiro_nome: payload.etapa.parceiro_nome,
            parceiro_tipo: payload.etapa.parceiro_tipo,
            parceiro_contato: payload.etapa.parceiro_contato,
            observacoes: payload.etapa.observacoes,
            atualizado_em: new Date().toISOString(),
          })
          .eq("id", orig.id);
        if (error) throw error;

        await recalcularComImpacto({
          fornecedor: payload.fornecedor,
          ltAntes,
          acao: "edicao",
          descricao: `Etapa "${orig.descricao}" editada: LT ${orig.lt_dias}d → ${payload.etapa.lt_dias}d`,
          etapa_codigo: orig.etapa_codigo,
          valoresAnt: orig,
          valoresNov: payload.etapa,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
      setEditandoEtapa(null);
      setNovaEtapaForn(null);
    },
    onError: (e: Error) => toast.error(`Erro ao salvar: ${e.message}`),
  });

  // Desativar
  const desativarMut = useMutation({
    mutationFn: async (etapa: Etapa) => {
      const ltAntes = await ltTotalAtualForn(etapa.fornecedor_nome);
      const { error } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ativo: false, valido_ate: new Date().toISOString().split("T")[0] })
        .eq("id", etapa.id);
      if (error) throw error;
      await recalcularComImpacto({
        fornecedor: etapa.fornecedor_nome,
        ltAntes,
        acao: "desativacao",
        descricao: `Etapa "${etapa.descricao}" desativada (era ${etapa.lt_dias}d)`,
        etapa_codigo: etapa.etapa_codigo,
        valoresAnt: etapa,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
    },
    onError: (e: Error) => toast.error(`Erro ao desativar: ${e.message}`),
  });

  // Trocar parceiro
  const trocarParceiroMut = useMutation({
    mutationFn: async (args: {
      etapa: Etapa;
      novoParceiro: string;
      novoTipo: string;
      novoContato: string;
      novoLt: number;
      novaUnidade: string;
      dataTroca: string;
    }) => {
      const ltAntes = await ltTotalAtualForn(args.etapa.fornecedor_nome);
      // 1. Marca etapa atual como expirada
      const { error: e1 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ativo: false, valido_ate: args.dataTroca })
        .eq("id", args.etapa.id);
      if (e1) throw e1;

      // 2. Cria nova etapa com mesma ordem e código novo
      const novoCodigo = `${args.etapa.etapa_codigo}_T${Date.now().toString(36)}`;
      const { error: e2 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .insert({
          empresa: args.etapa.empresa,
          fornecedor_nome: args.etapa.fornecedor_nome,
          ordem: args.etapa.ordem,
          etapa_codigo: novoCodigo,
          descricao: args.etapa.descricao,
          lt_dias: args.novoLt,
          lt_unidade: args.novaUnidade,
          parceiro_nome: args.novoParceiro,
          parceiro_tipo: args.novoTipo,
          parceiro_contato: args.novoContato,
          observacoes: args.etapa.observacoes,
          valido_desde: args.dataTroca,
          ativo: true,
        });
      if (e2) throw e2;

      await recalcularComImpacto({
        fornecedor: args.etapa.fornecedor_nome,
        ltAntes,
        acao: "troca_parceiro",
        descricao: `Parceiro da etapa "${args.etapa.descricao}" trocado: ${args.etapa.parceiro_nome ?? "—"} → ${args.novoParceiro}`,
        etapa_codigo: novoCodigo,
        valoresAnt: {
          parceiro: args.etapa.parceiro_nome,
          lt: args.etapa.lt_dias,
        },
        valoresNov: { parceiro: args.novoParceiro, lt: args.novoLt },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
      setTrocandoParceiro(null);
    },
    onError: (e: Error) => toast.error(`Erro ao trocar: ${e.message}`),
  });

  // Reordenar (move up/down)
  const reordenarMut = useMutation({
    mutationFn: async (args: { etapa: Etapa; direcao: "up" | "down" }) => {
      const lista = (etapas ?? [])
        .filter(
          (e) =>
            e.empresa === EMPRESA &&
            e.fornecedor_nome === args.etapa.fornecedor_nome &&
            e.ativo,
        )
        .sort((a, b) => a.ordem - b.ordem);
      const idx = lista.findIndex((e) => e.id === args.etapa.id);
      const swapIdx = args.direcao === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= lista.length) return;
      const outro = lista[swapIdx];
      // Swap ordens
      const { error: e1 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ordem: outro.ordem })
        .eq("id", args.etapa.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase
        .from("fornecedor_cadeia_logistica")
        .update({ ordem: args.etapa.ordem })
        .eq("id", outro.id);
      if (e2) throw e2;

      await supabase.from("fornecedor_cadeia_logistica_historico").insert({
        empresa: EMPRESA,
        fornecedor_nome: args.etapa.fornecedor_nome,
        etapa_codigo: args.etapa.etapa_codigo,
        acao: "reordenacao",
        descricao_mudanca: `Etapa "${args.etapa.descricao}" reordenada`,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cadeia-etapas"] });
      qc.invalidateQueries({ queryKey: ["cadeia-historico"] });
    },
    onError: (e: Error) => toast.error(`Erro ao reordenar: ${e.message}`),
  });

  // Agrupar etapas por fornecedor
  const etapasPorForn = useMemo(() => {
    const map = new Map<string, Etapa[]>();
    (etapas ?? []).forEach((e) => {
      const key = e.fornecedor_nome;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    });
    map.forEach((arr) => arr.sort((a, b) => a.ordem - b.ordem));
    return map;
  }, [etapas]);

  function toggleExp(forn: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(forn)) next.delete(forn);
      else next.add(forn);
      return next;
    });
  }

  return {
    podeEditar,
    loadingForn,
    loadingEt,
    fornecedores,
    historico,
    expanded,
    toggleExp,
    editandoEtapa,
    setEditandoEtapa,
    novaEtapaForn,
    setNovaEtapaForn,
    trocandoParceiro,
    setTrocandoParceiro,
    etapasPorForn,
    salvarEtapaMut,
    desativarMut,
    trocarParceiroMut,
    reordenarMut,
  };
}
