// Acesso ao picking v2 (tabelas e RPCs da migration 20261011020000 + 20261011120000).
// Leitura: RLS staff. Escrita: só RPCs SECURITY DEFINER — o aparelho nunca grava tabela direto.
import { supabase } from "@/integrations/supabase/client";
import { classificarErro } from "./erro-rpc";
import type { Comando, RespostaLeitura, ResultadoEnvio } from "./scanner/fila";
import type { CodigoCadastrado } from "./validacao-local";
import type { LeituraServidor, LinhaServidor } from "./progresso-local";

export type Conta = "oben" | "colacor";

type StatusTarefa =
  | "aguardando"
  | "em_separacao"
  | "separado"
  | "aguardando_ajuste"
  | "suspensa_alteracao"
  | "interrompida_externa"
  | "bloqueado_dado";

export interface TarefaV2 {
  id: string;
  account: Conta;
  omie_codigo_pedido: number;
  numero_pedido: string | null;
  cliente_nome: string | null;
  status: StatusTarefa;
  revisao: number;
  estado_seq: number;
  operador_id: string | null;
  atribuicao_id: string | null;
  motivo_bloqueio: string | null;
  ausente_rodadas: number;
  incluido_em: string | null;
}

export interface LinhaV2 extends LinhaServidor {
  codigo_produto: string | null;
  descricao: string | null;
}

const PAGINA = 1000;

/** Lê tudo em páginas (o PostgREST corta em 1.000 em silêncio). `consulta(de, ate)` com ordem estável. */
async function lerTudo<T>(consulta: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await consulta(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    // data nulo sem erro NÃO é fim de lista: devolver o parcial como completo é a classe #1338.
    if (data == null) throw new Error("página sem dados e sem erro");
    out.push(...data);
    if (data.length < PAGINA) return out;
  }
}

const COLUNAS_TAREFA =
  "id, account, omie_codigo_pedido, numero_pedido, cliente_nome, status, revisao, estado_seq, operador_id, atribuicao_id, motivo_bloqueio, ausente_rodadas, incluido_em";

/** Fila da conta: tudo que não terminou (separado e interrompida ficam de fora). */
export function listarFila(conta: Conta): Promise<TarefaV2[]> {
  return lerTudo<TarefaV2>((de, ate) =>
    supabase
      .from("picking_tarefas")
      .select(COLUNAS_TAREFA)
      .eq("account", conta)
      .in("status", ["aguardando", "em_separacao", "aguardando_ajuste", "suspensa_alteracao", "bloqueado_dado"])
      .order("incluido_em", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .range(de, ate) as unknown as PromiseLike<{ data: TarefaV2[] | null; error: { message: string } | null }>,
  );
}

export async function lerTarefa(id: string): Promise<TarefaV2> {
  const { data, error } = await supabase.from("picking_tarefas").select(COLUNAS_TAREFA).eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as unknown as TarefaV2;
}

export async function lerLinhas(tarefaId: string): Promise<LinhaV2[]> {
  const linhas = await lerTudo<Record<string, unknown>>((de, ate) =>
    supabase
      .from("picking_linhas")
      .select("id, codigo_item, omie_codigo_produto, codigo_produto, descricao, quantidade, unidade, ean, fracionaria, ativa, revisao")
      .eq("tarefa_id", tarefaId)
      .order("codigo_item", { ascending: true })
      .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
  );
  return linhas.map((l) => ({
    id: String(l.id),
    codigo_item: Number(l.codigo_item),
    omie_codigo_produto: Number(l.omie_codigo_produto),
    codigo_produto: (l.codigo_produto as string | null) ?? null,
    descricao: (l.descricao as string | null) ?? null,
    quantidade: Number(l.quantidade),
    unidade: String(l.unidade),
    ean: (l.ean as string | null) ?? null,
    fracionaria: Boolean(l.fracionaria),
    ativa: Boolean(l.ativa),
    revisao: Number(l.revisao),
  }));
}

export async function lerLeituras(tarefaId: string): Promise<LeituraServidor[]> {
  const ls = await lerTudo<Record<string, unknown>>((de, ate) =>
    supabase
      .from("picking_leituras")
      .select("id, linha_id, linha_revisao, unidades, aceita")
      .eq("tarefa_id", tarefaId)
      .order("id", { ascending: true })
      .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
  );
  return ls.map((l) => ({
    id: String(l.id),
    linha_id: (l.linha_id as string | null) ?? null,
    linha_revisao: l.linha_revisao === null ? null : Number(l.linha_revisao),
    unidades: l.unidades === null ? null : Number(l.unidades),
    aceita: Boolean(l.aceita),
  }));
}

/** Códigos cadastrados (não revogados) dos produtos da tarefa — base da previsão local do bipe. */
export async function lerCodigos(conta: Conta, produtos: number[]): Promise<CodigoCadastrado[]> {
  if (produtos.length === 0) return [];
  const cs = await lerTudo<Record<string, unknown>>((de, ate) =>
    supabase
      .from("picking_codigos_barras")
      .select("codigo, omie_codigo_produto, unidade, unidades_por_leitura, status")
      .eq("account", conta)
      .neq("status", "revogado")
      .in("omie_codigo_produto", produtos)
      .order("codigo", { ascending: true })
      .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
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

/** Envio de UMA leitura da fila (idempotente pelo `leitura_id`). */
export async function enviarLeitura(c: Comando): Promise<ResultadoEnvio> {
  try {
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
    });
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

export interface ResultadoComando {
  ok: boolean;
  motivo?: string;
  atribuicao_id?: string;
  tarefa_revisao?: number;
  estado_seq?: number;
}

async function rpcComando(nome: string, args: Record<string, unknown>): Promise<ResultadoComando> {
  const { data, error } = await supabase.rpc(nome as "picking_pegar_task", args as never);
  if (error) throw Object.assign(new Error(error.message), { code: (error as { code?: string }).code });
  return (data ?? { ok: false, motivo: "sem_resposta" }) as unknown as ResultadoComando;
}

export function pegarTarefa(t: TarefaV2, opts: { assumir?: boolean; reconciliacao?: boolean } = {}) {
  return rpcComando("picking_pegar_task", {
    p_evento_id: crypto.randomUUID(),
    p_account: t.account,
    p_tarefa_id: t.id,
    p_estado_seq: t.estado_seq,
    p_assumir: opts.assumir ?? false,
    p_reconciliacao_fisica: opts.reconciliacao ?? false,
  });
}

export function retomarTarefa(t: TarefaV2, reconciliacao: boolean) {
  return rpcComando("picking_retomar", {
    p_evento_id: crypto.randomUUID(),
    p_account: t.account,
    p_tarefa_id: t.id,
    p_estado_seq: t.estado_seq,
    p_reconciliacao_fisica: reconciliacao,
  });
}

export function marcarFalta(t: TarefaV2, atribuicaoId: string, linhaId: string, observacao?: string) {
  return rpcComando("picking_marcar_falta", {
    p_evento_id: crypto.randomUUID(),
    p_account: t.account,
    p_tarefa_id: t.id,
    p_atribuicao_id: atribuicaoId,
    p_linha_id: linhaId,
    p_observacao: observacao ?? null,
  });
}

export function concluirTarefa(t: TarefaV2, atribuicaoId: string, revisao: number, leituras: string[]) {
  return rpcComando("picking_concluir", {
    p_evento_id: crypto.randomUUID(),
    p_account: t.account,
    p_tarefa_id: t.id,
    p_atribuicao_id: atribuicaoId,
    p_tarefa_revisao: revisao,
    p_leituras: leituras,
  });
}
