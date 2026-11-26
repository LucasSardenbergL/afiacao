// Leituras e ações da tela /credito/limites (crédito-IA PR 4).
// Leitura: RPC credito_fila_propostas (gestor/master; nega com 42501 — a tela mostra "sem acesso").
// Ação: só o aprovador de crédito (credito_sou_aprovador) — o banco é quem barra; o botão só some.
// "Avaliar agora" chama a edge, que registra a execução server-side (slug credito.avaliar_limites):
// por isso `useMutation` + invalidar a última execução, e não `useMutationComRegistro`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/postgrest";
import { mensagemDeErro } from "@/lib/erro-mensagem";
import { ULTIMA_EXECUCAO_QUERY_KEY } from "@/components/execucoes/tipos";
import { emBlocos, lerResultadoLote, type PropostaFila, type ResultadoLote } from "./limites";

export const ACAO_AVALIAR = "credito.avaliar_limites";
const CHAVE = "credito-limites";

export type StatusFila = "pendente" | "aprovada" | "recusada" | "expirada";

export function useFilaPropostas(status: StatusFila) {
  return useQuery({
    queryKey: [CHAVE, "fila", status],
    queryFn: async () => {
      const linhas = await fetchAllPages(
        (de, ate) => supabase.rpc("credito_fila_propostas", { p_status: status }).range(de, ate),
        "credito_fila_propostas",
      );
      return linhas as unknown as PropostaFila[];
    },
  });
}

export function useSouAprovador() {
  return useQuery({
    queryKey: [CHAVE, "sou-aprovador"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("credito_sou_aprovador");
      if (error) throw error;
      return data === true;
    },
  });
}

export type Progresso = {
  carteira: number; vigentes: number; pendentes: number; em_retry: number; nunca_avaliadas: number;
  ultima_avaliacao_em: string | null;
};

export function useProgresso() {
  return useQuery({
    queryKey: [CHAVE, "progresso"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("credito_avaliacao_progresso");
      if (error) throw error;
      return data as unknown as Progresso;
    },
  });
}

/** Aprova em blocos de ≤ 50 e reconcilia por id (o erro de um não esconde o resto). */
export function useAprovarLote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]): Promise<ResultadoLote[]> => {
      const todos: ResultadoLote[] = [];
      // Um bloco que falha NÃO descarta os já aprovados (Codex diff P2-9): os ids dele saem como
      // "não confirmado" — a resposta pode ter se perdido depois do commit; a fila recarregada é a verdade.
      for (const bloco of emBlocos(ids)) {
        try {
          const { data, error } = await supabase.rpc("credito_aprovar_propostas_lote", { p_ids: bloco });
          if (error) throw error;
          todos.push(...lerResultadoLote(data));
        } catch (e) {
          const msg = mensagemDeErro(e) ?? "falha de rede";
          todos.push(...bloco.map((id) => ({ id, ok: false, erro: `não confirmado (${msg}) — recarregue a fila` })));
        }
      }
      return todos;
    },
    onSuccess: (res) => {
      const ok = res.filter((r) => r.ok).length;
      const falhas = res.length - ok;
      if (falhas === 0) toast.success(`${ok} limite(s) aprovado(s)`);
      else toast.warning(`${ok} aprovado(s), ${falhas} não aprovado(s) — veja o motivo em cada linha`);
    },
    onError: (e) => toast.error(mensagemDeErro(e) ?? "Falha ao aprovar"),
    onSettled: () => qc.invalidateQueries({ queryKey: [CHAVE] }),
  });
}

export function useRecusar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, motivo }: { id: string; motivo: string }) => {
      const { error } = await supabase.rpc("credito_recusar_proposta", { p_proposta_id: id, p_motivo: motivo });
      if (error) throw error;
    },
    onSuccess: () => toast.success("Proposta recusada"),
    onError: (e) => toast.error(mensagemDeErro(e) ?? "Falha ao recusar"),
    onSettled: () => qc.invalidateQueries({ queryKey: [CHAVE] }),
  });
}

export function useAvaliarAgora() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("credito-ia-avaliar", { body: { origem: "tela" } });
      if (error) throw error;
      const r = data as { ok?: boolean; propostas?: number; falhas?: number; reivindicadas?: number; mensagem?: string };
      if (!r?.ok) throw new Error(r?.mensagem ?? "A avaliação não terminou");
      return r;
    },
    onSuccess: (r) => toast.success(
      r.reivindicadas ? `${r.propostas ?? 0} proposta(s) nova(s), ${r.falhas ?? 0} falha(s)` : "Nenhum grupo elegível agora"),
    onError: (e) => toast.error(mensagemDeErro(e) ?? "Falha ao avaliar"),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [CHAVE] });
      qc.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] });
    },
  });
}
