// Lógica da aba de Configuração de meta trimestral do DES.
// Carrega a meta de (empresa, ano, trimestre), preenche o form, e faz upsert
// (a unique constraint uq_meta em (empresa, ano, trimestre) torna o upsert idempotente).
// Master-only no client (a RLS master-only de des_meta_empresa é a autoridade real).
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  parseMetaInput,
  parseFaixaInput,
  isMetaValida,
  classificarPeriodo,
  anosSelecionaveis,
  formatMetaParaInput,
  type Periodo,
} from "./format";
import type { MetaRow } from "./types";

export function useConfiguracaoMeta(empresa: string, anoAtual: number, trimestreAtual: number) {
  const { isMaster } = useAuth();
  const qc = useQueryClient();

  const [ano, setAno] = useState(anoAtual);
  const [trimestre, setTrimestre] = useState(trimestreAtual);
  const [metaInput, setMetaInput] = useState("");
  const [faixaInput, setFaixaInput] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [saving, setSaving] = useState(false);

  const metaQuery = useQuery({
    queryKey: ["des-config-meta", empresa, ano, trimestre],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("des_meta_empresa")
        .select("id, empresa, ano, trimestre, meta_faturamento, faixa_des_objetivo, observacoes")
        .eq("empresa", empresa)
        .eq("ano", ano)
        .eq("trimestre", trimestre)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as MetaRow | null;
    },
  });

  const loaded = metaQuery.data ?? null;

  // Preenche (ou limpa) o form a partir da meta carregada para o período selecionado.
  useEffect(() => {
    if (metaQuery.isLoading) return;
    setMetaInput(formatMetaParaInput(loaded?.meta_faturamento));
    setFaixaInput(loaded?.faixa_des_objetivo != null ? String(loaded.faixa_des_objetivo) : "");
    setObservacoes(loaded?.observacoes ?? "");
  }, [loaded, metaQuery.isLoading]);

  const metaParsed = parseMetaInput(metaInput);
  const faixaVazia = faixaInput.trim() === "";
  const faixaParsed = parseFaixaInput(faixaInput);
  const metaOk = isMetaValida(metaParsed);
  // Faixa é opcional: vazio é ok; se preenchida, precisa parsear para inteiro >= 1.
  const faixaOk = faixaVazia || faixaParsed != null;
  const periodo: Periodo = classificarPeriodo(ano, trimestre, anoAtual, trimestreAtual);
  const existe = !!loaded;

  // Rascunho não salvo (form difere da meta carregada) — guarda a troca de período.
  const dirty =
    metaInput !== formatMetaParaInput(loaded?.meta_faturamento) ||
    faixaInput !== (loaded?.faixa_des_objetivo != null ? String(loaded.faixa_des_objetivo) : "") ||
    observacoes !== (loaded?.observacoes ?? "");

  function confirmarTroca(): boolean {
    return !dirty || window.confirm("Há alterações não salvas. Descartá-las e trocar de período?");
  }
  function trocarAno(v: number) {
    if (v !== ano && confirmarTroca()) setAno(v);
  }
  function trocarTrimestre(v: number) {
    if (v !== trimestre && confirmarTroca()) setTrimestre(v);
  }

  async function salvar() {
    if (!isMaster) {
      toast.error("Apenas um usuário master pode cadastrar metas.");
      return;
    }
    if (metaParsed == null || !isMetaValida(metaParsed)) {
      toast.error("Informe um valor de meta válido (maior que zero).");
      return;
    }
    if (!faixaOk) {
      toast.error("Faixa-alvo inválida (use um inteiro ≥ 1, ou deixe em branco).");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("des_meta_empresa").upsert(
        {
          empresa,
          ano,
          trimestre,
          meta_faturamento: metaParsed,
          faixa_des_objetivo: faixaParsed,
          observacoes: observacoes.trim() || null,
        },
        { onConflict: "empresa,ano,trimestre" },
      );
      if (error) throw error;

      toast.success(existe ? "Meta atualizada." : "Meta cadastrada.");
      // Invalida tudo que depende da meta no DES (histórico, posição ao vivo, checkin).
      qc.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("des-"),
      });
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : "desconhecido";
      toast.error("Erro ao salvar meta: " + msg);
    } finally {
      setSaving(false);
    }
  }

  return {
    isMaster,
    ano,
    setAno: trocarAno,
    trimestre,
    setTrimestre: trocarTrimestre,
    anos: anosSelecionaveis(anoAtual),
    metaInput,
    setMetaInput,
    faixaInput,
    setFaixaInput,
    observacoes,
    setObservacoes,
    metaOk,
    faixaOk,
    faixaVazia,
    periodo,
    existe,
    saving,
    isLoading: metaQuery.isLoading,
    salvar,
  };
}
