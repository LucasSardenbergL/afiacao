// Acesso ao picking v2 (tabelas e RPCs da migration 20261011020000 + 20261011140000).
// Leitura: RLS staff. Escrita: só RPCs SECURITY DEFINER — o aparelho nunca grava tabela direto.
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPagesComMensagem } from "@/lib/postgrest";
import type { Json } from "@/integrations/supabase/types";
import type { PostgrestError } from "@supabase/supabase-js";
import { type Conta, lerResultadoComando, paraTarefaV2, type ResultadoComando, type TarefaV2 } from "./borda-rpc";
import { classificarErro } from "./erro-rpc";
import type { Comando, RespostaLeitura, ResultadoEnvio } from "./scanner/fila";
import type { CodigoCadastrado } from "./validacao-local";
import type { LeituraServidor, LinhaServidor } from "./progresso-local";

export type { Conta, ResultadoComando, TarefaV2 } from "./borda-rpc";

export interface LinhaV2 extends LinhaServidor {
  codigo_produto: string | null;
  descricao: string | null;
}

// Leituras paginadas pelo canônico (o PostgREST corta em 1.000 em silêncio): página com error ou
// `data: null` sem error LANÇA — devolver o parcial como completo é a classe #1338 — e a página
// perdida é medida pela fonte. Ordem estável com chave total em todas.

const COLUNAS_TAREFA =
  "id, account, omie_codigo_pedido, numero_pedido, cliente_nome, status, revisao, estado_seq, operador_id, atribuicao_id, motivo_bloqueio, ausente_rodadas, incluido_em";

/** Fila da conta: tudo que não terminou (separado e interrompida ficam de fora). */
export async function listarFila(conta: Conta): Promise<TarefaV2[]> {
  const linhas = await fetchAllPagesComMensagem((de, ate) =>
    supabase
      .from("picking_tarefas")
      .select(COLUNAS_TAREFA)
      .eq("account", conta)
      .in("status", ["aguardando", "em_separacao", "aguardando_ajuste", "suspensa_alteracao", "bloqueado_dado"])
      .order("incluido_em", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .range(de, ate),
    "picking_tarefas/fila-v2",
    "picking_tarefas",
  );
  return linhas.map(paraTarefaV2);
}

export async function lerTarefa(id: string): Promise<TarefaV2> {
  const { data, error } = await supabase.from("picking_tarefas").select(COLUNAS_TAREFA).eq("id", id).single();
  if (error) throw new Error(error.message);
  return paraTarefaV2(data);
}

export async function lerLinhas(tarefaId: string): Promise<LinhaV2[]> {
  const linhas = await fetchAllPagesComMensagem((de, ate) =>
    supabase
      .from("picking_linhas")
      .select("id, codigo_item, omie_codigo_produto, codigo_produto, descricao, quantidade, unidade, ean, fracionaria, ativa, revisao")
      .eq("tarefa_id", tarefaId)
      .order("codigo_item", { ascending: true })
      .range(de, ate),
    "picking_linhas/tarefa-v2",
    "picking_linhas",
  );
  return linhas.map((l) => ({
    id: String(l.id),
    codigo_item: Number(l.codigo_item),
    omie_codigo_produto: Number(l.omie_codigo_produto),
    codigo_produto: l.codigo_produto,
    descricao: l.descricao,
    quantidade: Number(l.quantidade),
    unidade: String(l.unidade),
    ean: l.ean,
    fracionaria: Boolean(l.fracionaria),
    ativa: Boolean(l.ativa),
    revisao: Number(l.revisao),
  }));
}

export async function lerLeituras(tarefaId: string): Promise<LeituraServidor[]> {
  const ls = await fetchAllPagesComMensagem((de, ate) =>
    supabase
      .from("picking_leituras")
      .select("id, linha_id, linha_revisao, unidades, aceita")
      .eq("tarefa_id", tarefaId)
      .order("id", { ascending: true })
      .range(de, ate),
    "picking_leituras/tarefa-v2",
    "picking_leituras",
  );
  return ls.map((l) => ({
    id: String(l.id),
    linha_id: l.linha_id,
    linha_revisao: l.linha_revisao === null ? null : Number(l.linha_revisao),
    unidades: l.unidades === null ? null : Number(l.unidades),
    aceita: Boolean(l.aceita),
  }));
}

/** Códigos cadastrados (não revogados) dos produtos da tarefa — base da previsão local do bipe. */
export async function lerCodigos(conta: Conta, produtos: number[]): Promise<CodigoCadastrado[]> {
  if (produtos.length === 0) return [];
  const cs = await fetchAllPagesComMensagem((de, ate) =>
    supabase
      .from("picking_codigos_barras")
      .select("codigo, omie_codigo_produto, unidade, unidades_por_leitura, status")
      .eq("account", conta)
      .neq("status", "revogado")
      .in("omie_codigo_produto", produtos)
      .order("codigo", { ascending: true })
      .order("id", { ascending: true })
      .range(de, ate),
    "picking_codigos_barras/previsao-bipe",
    "picking_codigos_barras",
  );
  return cs.map((c) => ({
    codigo: String(c.codigo),
    omie_codigo_produto: Number(c.omie_codigo_produto),
    unidade: String(c.unidade),
    unidades_por_leitura: Number(c.unidades_por_leitura),
    status: c.status === "aprovado" ? "aprovado" : "pendente",
  }));
}

// ─── RPCs ────────────────────────────────────────────────────────────────────────────────────

/**
 * Envio de UMA leitura da fila (idempotente pelo `leitura_id`), autenticado como `dono`: o token
 * vai FIXO no cabeçalho, da mesma sessão conferida aqui — sem isso o SDK faria outro
 * `getSession()` e, se outra aba trocou o login no meio, a leitura de U1 sairia como U2 e viraria
 * `atribuicao_antiga` definitiva (Codex Fase 1 r3).
 */
export async function enviarLeitura(c: Comando, dono: string): Promise<ResultadoEnvio> {
  try {
    const sessao = (await supabase.auth.getSession()).data.session;
    if (!sessao || sessao.user.id !== dono) return { tipo: "transitorio", erro: "sessão de outro usuário — envio pausado" };
    const { data, error } = await supabase.rpc("picking_registrar_leitura", {
      p_leitura_id: c.leitura_id,
      p_account: c.account,
      p_tarefa_id: c.tarefa_id,
      p_atribuicao_id: c.atribuicao_id,
      p_tarefa_revisao: c.tarefa_revisao,
      p_tipo: c.tipo,
      p_codigo_lido: c.codigo_lido ?? undefined,
      p_linha_id: c.linha_id ?? undefined,
      p_quantidade: c.quantidade ?? undefined,
      p_estorna_leitura_id: c.estorna_leitura_id ?? undefined,
      p_lido_em: c.lido_em,
    }).setHeader("Authorization", `Bearer ${sessao.access_token}`);
    if (error) return classificarErro(error);
    const r = (data ?? {}) as Record<string, unknown>;
    const resposta: RespostaLeitura = {
      ok: r.ok === true,
      motivo: typeof r.motivo === "string" ? r.motivo : null,
      linha_id: typeof r.linha_id === "string" ? r.linha_id : null,
      unidades: r.unidades === null || r.unidades === undefined ? null : Number(r.unidades),
      pendente: r.pendente === true,
    };
    return { tipo: "resposta", resposta };
  } catch (e) {
    return classificarErro(e);
  }
}

// O retorno é `Json` no types.ts: a forma é conferida em `lerResultadoComando` (borda-rpc).
async function rpcComando(
  chamada: PromiseLike<{ data: Json | null; error: PostgrestError | null }>,
): Promise<ResultadoComando> {
  const { data, error } = await chamada;
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return lerResultadoComando(data);
}

export function pegarTarefa(t: TarefaV2, opts: { assumir?: boolean; reconciliacao?: boolean } = {}) {
  return rpcComando(
    supabase.rpc("picking_pegar_task", {
      p_evento_id: crypto.randomUUID(),
      p_account: t.account,
      p_tarefa_id: t.id,
      p_estado_seq: t.estado_seq,
      p_assumir: opts.assumir ?? false,
      p_reconciliacao_fisica: opts.reconciliacao ?? false,
    }),
  );
}

export function retomarTarefa(t: TarefaV2, reconciliacao: boolean) {
  return rpcComando(
    supabase.rpc("picking_retomar", {
      p_evento_id: crypto.randomUUID(),
      p_account: t.account,
      p_tarefa_id: t.id,
      p_estado_seq: t.estado_seq,
      p_reconciliacao_fisica: reconciliacao,
    }),
  );
}

export function marcarFalta(t: TarefaV2, atribuicaoId: string, linhaId: string, observacao?: string) {
  return rpcComando(
    supabase.rpc("picking_marcar_falta", {
      p_evento_id: crypto.randomUUID(),
      p_account: t.account,
      p_tarefa_id: t.id,
      p_atribuicao_id: atribuicaoId,
      p_linha_id: linhaId,
      p_observacao: observacao, // ausente → DEFAULT NULL da função
    }),
  );
}

export function concluirTarefa(t: TarefaV2, atribuicaoId: string, revisao: number, leituras: string[]) {
  return rpcComando(
    supabase.rpc("picking_concluir", {
      p_evento_id: crypto.randomUUID(),
      p_account: t.account,
      p_tarefa_id: t.id,
      p_atribuicao_id: atribuicaoId,
      p_tarefa_revisao: revisao,
      p_leituras: leituras,
    }),
  );
}
