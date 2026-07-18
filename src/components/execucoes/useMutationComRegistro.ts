import {
  useMutation,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { logger } from "@/lib/logger";
import { ULTIMA_EXECUCAO_QUERY_KEY } from "./tipos";

// Escrita em acoes_execucoes fora do types.ts gerado (regen é do Lovable) → cast estrutural.
interface EscritaExecucoes {
  from(tabela: "acoes_execucoes"): {
    insert(linha: Record<string, unknown>): {
      select(colunas: "id"): {
        single(): PromiseLike<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(coluna: "id", valor: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** Abre o registro da execução. FAIL-OPEN: qualquer falha → null (a ação real segue). */
async function iniciarRegistro(acao: string, userId: string | null): Promise<string | null> {
  try {
    let nome: string | null = null;
    if (userId) {
      const { data } = await supabase.from("profiles").select("name").eq("user_id", userId).maybeSingle();
      nome = (data as { name?: string } | null)?.name ?? null;
    }
    const cliente = supabase as unknown as EscritaExecucoes;
    const { data, error } = await cliente
      .from("acoes_execucoes")
      .insert({ acao, executado_por: userId, executado_por_nome: nome })
      .select("id")
      .single();
    if (error || !data) {
      logger.warn("registro de execução não abriu (fail-open)", { acao, erro: error?.message });
      return null;
    }
    return data.id;
  } catch (e) {
    logger.warn("registro de execução não abriu (fail-open)", { acao, erro: String(e) });
    return null;
  }
}

/** Fecha o registro. FAIL-OPEN: falha vira warn, nunca erro pro caller. */
async function fecharRegistro(
  registroId: string | null,
  status: "sucesso" | "erro",
  detalhes: Record<string, unknown> | null,
): Promise<void> {
  if (!registroId) return;
  try {
    const cliente = supabase as unknown as EscritaExecucoes;
    const { error } = await cliente
      .from("acoes_execucoes")
      .update({ status, finalizado_em: new Date().toISOString(), detalhes })
      .eq("id", registroId);
    if (error) logger.warn("registro de execução não fechou (fail-open)", { registroId, erro: error.message });
  } catch (e) {
    logger.warn("registro de execução não fechou (fail-open)", { registroId, erro: String(e) });
  }
}

type OpcoesMutationComRegistro<TData, TVariables> = Omit<
  UseMutationOptions<TData, Error, TVariables>,
  "mutationFn"
> & {
  /** Slug estável '<area>.<acao>' — o MESMO usado na caption <UltimaExecucao>. */
  acao: string;
  mutationFn: (variables: TVariables) => Promise<TData>;
  /** Resumo pequeno gravado em acoes_execucoes.detalhes no sucesso (contagens etc.). */
  detalhes?: (data: TData) => Record<string, unknown>;
};

/**
 * Drop-in do useMutation para BOTÃO DE AÇÃO GLOBAL (sincronizar/importar/recalcular/gerar):
 * registra a execução em acoes_execucoes (abre 'executando', fecha 'sucesso'/'erro') e
 * invalida a caption <UltimaExecucao>. Convenção do CLAUDE.md §Design System.
 * Ação de UM registro (reenviar item X) NÃO usa isto — o estado vive no próprio registro.
 * Edge single-shot (com cron) registra server-side via _shared/registro-execucao.ts — nunca os dois.
 */
export function useMutationComRegistro<TData, TVariables = void>({
  acao,
  mutationFn,
  detalhes,
  ...opcoes
}: OpcoesMutationComRegistro<TData, TVariables>): UseMutationResult<TData, Error, TVariables> {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation<TData, Error, TVariables>({
    ...opcoes,
    mutationFn: async (variables: TVariables) => {
      const registroId = await iniciarRegistro(acao, user?.id ?? null);
      try {
        const resultado = await mutationFn(variables);
        await fecharRegistro(registroId, "sucesso", detalhes?.(resultado) ?? null);
        return resultado;
      } catch (e) {
        await fecharRegistro(registroId, "erro", { erro: String(e).slice(0, 300) });
        throw e;
      } finally {
        queryClient.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] });
      }
    },
  });
}
