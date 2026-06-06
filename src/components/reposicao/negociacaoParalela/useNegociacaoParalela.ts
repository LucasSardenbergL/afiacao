// Camada de dados/lógica da Negociação Paralela v2 — fila por R$ líquido.
// Fonte: v_sku_parametros_sugeridos (CMC, preço de compra, giro, custo de capital).
// Mantém o ciclo de vida em sugestao_negociacao_paralela (status acao_tomada) e a conversão em campanha flat.
import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { EMPRESA, type Sugestao, type ConvertForm, type LinhaViewSugeridos, type CandidatoNegociacao } from "./types";
import { lastDayOfNextMonth } from "./helpers";
import { avaliarNegociacao, clampDesconto, DESCONTO_PADRAO } from "@/lib/reposicao/negociacao-valor-helpers";

const TOP_N = 3;

export function useNegociacaoParalela() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // desconto pedido por SKU (controle do card); default 8%.
  const [descontoPorSku, setDescontoPorSku] = useState<Record<string, number>>({});
  const [convertTarget, setConvertTarget] = useState<Sugestao | null>(null);
  const [convertForm, setConvertForm] = useState<ConvertForm>({
    desconto_perc: 8, volume_minimo: 0, volume_unidade: "unidades",
    data_fim: lastDayOfNextMonth(), responsavel: "", canal: "ligacao", observacoes: "",
  });
  const [convertSubmitting, setConvertSubmitting] = useState(false);
  const [fecharSemAcordoTarget, setFecharSemAcordoTarget] = useState<Sugestao | null>(null);
  const [fecharObs, setFecharObs] = useState("");

  // Fonte da fila: candidatos Sayerlack com insumos de custo/giro.
  const { data: linhas = [], isLoading: loadingFila } = useQuery({
    queryKey: ["neg-paralela-fila", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sku_parametros_sugeridos" as never)
        .select(
          "sku_codigo_omie, sku_descricao, demanda_media_diaria, preco_compra_real, preco_item_eoq, fonte_preco, custo_capital_efetivo_perc, fornecedor_nome, empresa" as never,
        )
        .eq("empresa", EMPRESA)
        .ilike("fornecedor_nome", "%SAYERLACK%");
      if (error) throw error;
      return (data ?? []) as unknown as LinhaViewSugeridos[];
    },
    staleTime: 60_000,
  });

  // Negociações que o usuário decidiu perseguir (status acao_tomada).
  const { data: emAndamento = [], isLoading: loadingAndamento } = useQuery({
    queryKey: ["neg-paralela-andamento", EMPRESA],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sugestao_negociacao_ativa" as never)
        .select("*")
        .eq("empresa", EMPRESA)
        .eq("status", "acao_tomada");
      if (error) throw error;
      return (data ?? []) as unknown as Sugestao[];
    },
    staleTime: 30_000,
  });

  // Monta candidatos (identidade + insumos), com gasto anual = preco_compra × consumo.
  const candidatos = useMemo<CandidatoNegociacao[]>(() => {
    return linhas.map((l) => {
      const sku = String(l.sku_codigo_omie);
      const A = Number(l.demanda_media_diaria ?? 0) * 365;
      const p = l.preco_compra_real != null ? Number(l.preco_compra_real) : null;
      const cmc = l.fonte_preco === "cmc" && l.preco_item_eoq != null ? Number(l.preco_item_eoq) : null;
      const k = Number(l.custo_capital_efetivo_perc ?? 0) / 100;
      return {
        sku_codigo_omie: sku,
        sku_descricao: l.sku_descricao,
        consumo_anual: A,
        preco_compra: p,
        cmc,
        custo_capital_anual: k,
        gasto_anual: p != null && A > 0 ? p * A : null,
      };
    });
  }, [linhas]);

  const descontoDe = (sku: string) => clampDesconto(descontoPorSku[sku] ?? DESCONTO_PADRAO);

  // Fila Top 3: só elegíveis (têm preço de compra E cmc E giro), ordenados por prêmio anual.
  const fila = useMemo(() => {
    const avaliados = candidatos.map((c) => ({
      candidato: c,
      // ordenação usa o desconto-base (8%); a ordem por gasto independe do δ.
      avaliacao: avaliarNegociacao(
        { sku_codigo_omie: c.sku_codigo_omie, sku_descricao: c.sku_descricao, consumo_anual: c.consumo_anual, preco_compra: c.preco_compra, cmc: c.cmc, custo_capital_anual: c.custo_capital_anual },
        DESCONTO_PADRAO,
      ),
    }));
    return avaliados
      .filter((a) => a.avaliacao.elegivel)
      .sort((a, b) => (b.avaliacao.premio_anual ?? 0) - (a.avaliacao.premio_anual ?? 0))
      .slice(0, TOP_N);
  }, [candidatos]);

  const setDesconto = (sku: string, perc: number) =>
    setDescontoPorSku((prev) => ({ ...prev, [sku]: perc }));

  // "Vou negociar este" → cria sugestão acao_tomada (puxa da fila pro acompanhamento).
  const handleVouNegociar = async (c: CandidatoNegociacao) => {
    try {
      const validoAte = new Date();
      validoAte.setDate(validoAte.getDate() + 30);
      const { error } = await supabase.from("sugestao_negociacao_paralela").insert({
        empresa: EMPRESA,
        sku_codigo_omie: c.sku_codigo_omie,
        sku_descricao: c.sku_descricao,
        motivo: "combinacao_heuristica",
        motivo_detalhes: { criado_via: "fila_v2", gasto_anual: c.gasto_anual },
        preco_medio_unitario: c.preco_compra,
        status: "acao_tomada",
        data_acao: new Date().toISOString(),
        data_geracao: new Date().toISOString().slice(0, 10),
        valido_ate: validoAte.toISOString().slice(0, 10),
      } as never);
      if (error) throw error;
      toast.success(`Negociação iniciada para ${c.sku_descricao ?? c.sku_codigo_omie}.`);
      queryClient.invalidateQueries({ queryKey: ["neg-paralela-andamento"] });
    } catch (err) {
      toast.error("Erro ao iniciar negociação: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const openConvertDialog = (s: Sugestao) => {
    setConvertTarget(s);
    setConvertForm({
      desconto_perc: 8, volume_minimo: 0, volume_unidade: "unidades",
      data_fim: lastDayOfNextMonth(), responsavel: "", canal: "ligacao", observacoes: "",
    });
  };

  const handleConverterConfirm = async () => {
    if (!convertTarget) return;
    if (convertForm.desconto_perc < 1 || convertForm.desconto_perc > 50) {
      toast.error("Desconto deve estar entre 1 e 50%."); return;
    }
    if (convertForm.volume_minimo <= 0) { toast.error("Volume mínimo deve ser maior que zero."); return; }
    setConvertSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("converter_sugestao_em_campanha_flat" as never, {
        p_sugestao_id: convertTarget.id,
        p_desconto_perc: convertForm.desconto_perc,
        p_volume_minimo: convertForm.volume_minimo,
        p_volume_unidade: convertForm.volume_unidade,
        p_data_fim: convertForm.data_fim,
        p_responsavel_nome: convertForm.responsavel || null,
        p_canal: convertForm.canal,
        p_observacoes: convertForm.observacoes || null,
      } as never);
      if (error) throw error;
      toast.success("Negociação convertida em campanha.");
      queryClient.invalidateQueries({ queryKey: ["neg-paralela-andamento"] });
      const campanhaId = typeof data === "number" || typeof data === "string" ? data : null;
      navigate(campanhaId ? `/admin/reposicao/promocoes/${campanhaId}` : `/admin/reposicao/promocoes`);
      setConvertTarget(null);
    } catch (err) {
      toast.error("Erro ao converter: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setConvertSubmitting(false);
    }
  };

  const handleFecharSemAcordoConfirm = async () => {
    if (!fecharSemAcordoTarget) return;
    const { error } = await supabase.from("sugestao_negociacao_paralela")
      .update({ status: "fechada_sem_acordo", observacoes: fecharObs || null, data_acao: new Date().toISOString() } as never)
      .eq("id", fecharSemAcordoTarget.id);
    if (error) { toast.error("Erro: " + error.message); return; }
    toast.success("Negociação encerrada sem acordo.");
    queryClient.invalidateQueries({ queryKey: ["neg-paralela-andamento"] });
    setFecharSemAcordoTarget(null);
    setFecharObs("");
  };

  return {
    loadingFila, loadingAndamento, fila, emAndamento,
    descontoDe, setDesconto, avaliarNegociacao, handleVouNegociar,
    convertTarget, setConvertTarget, convertForm, setConvertForm, convertSubmitting,
    openConvertDialog, handleConverterConfirm,
    fecharSemAcordoTarget, setFecharSemAcordoTarget, fecharObs, setFecharObs, handleFecharSemAcordoConfirm,
  };
}
