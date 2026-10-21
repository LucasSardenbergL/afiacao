// Borda do picking (v1 e v2): o que o types.ts não sabe dizer (vocabulário de texto e jsonb de RPC) é
// conferido AQUI, lançando fora da forma, em vez de afirmado por cast. Puro — testável sem cliente.
import type { Json, Tables } from "@/integrations/supabase/types";

const CONTAS = ["oben", "colacor"] as const;
export type Conta = (typeof CONTAS)[number];

// = CHECK de picking_tarefas.status em prod (conferido 2026-10-20).
const STATUS_TAREFA = [
  "aguardando",
  "em_separacao",
  "separado",
  "aguardando_ajuste",
  "suspensa_alteracao",
  "interrompida_externa",
  "bloqueado_dado",
] as const;
type StatusTarefa = (typeof STATUS_TAREFA)[number];

type ColunaTarefa =
  | "id"
  | "account"
  | "omie_codigo_pedido"
  | "numero_pedido"
  | "cliente_nome"
  | "status"
  | "revisao"
  | "estado_seq"
  | "operador_id"
  | "atribuicao_id"
  | "motivo_bloqueio"
  | "ausente_rodadas"
  | "incluido_em";

type LinhaTarefa = Pick<Tables<"picking_tarefas">, ColunaTarefa>;

export interface TarefaV2 extends Omit<LinhaTarefa, "account" | "status"> {
  account: Conta;
  status: StatusTarefa;
}

const ehConta = (v: string): v is Conta => (CONTAS as readonly string[]).includes(v);
const ehStatus = (v: string): v is StatusTarefa => (STATUS_TAREFA as readonly string[]).includes(v);

/** Linha de `picking_tarefas` → TarefaV2. Conta/status fora do CHECK de prod LANÇA. */
export function paraTarefaV2(l: LinhaTarefa): TarefaV2 {
  const { account, status } = l;
  if (!ehConta(account)) throw new Error(`picking_tarefas ${l.id}: account desconhecida "${account}"`);
  if (!ehStatus(status)) throw new Error(`picking_tarefas ${l.id}: status desconhecido "${status}"`);
  return { ...l, account, status };
}

export interface ResultadoComando {
  ok: boolean;
  motivo?: string;
  atribuicao_id?: string;
  tarefa_revisao?: number;
  estado_seq?: number;
}

type ObjetoJson = { [k: string]: Json | undefined };

function texto(o: ObjetoJson, chave: string): string | undefined {
  const v = o[chave];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`resposta de comando do picking: "${chave}" não é texto`);
  return v;
}

function numero(o: ObjetoJson, chave: string): number | undefined {
  const v = o[chave];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number") throw new Error(`resposta de comando do picking: "${chave}" não é número`);
  return v;
}

/**
 * jsonb das RPCs de comando (picking_pegar_task/retomar/marcar_falta/concluir). Em prod TODO ramo
 * monta `ok`; `data` NULL é o replay de evento sem resultado gravado (NULL || jsonb = NULL) e
 * segue como "sem_resposta". Fora disso: `ok` ausente ou não-booleano LANÇA (forma desconhecida);
 * as chaves opcionais ausentes ou NULL viram `undefined`, com tipo errado LANÇAM.
 */
export function lerResultadoComando(data: Json | null): ResultadoComando {
  if (data === null) return { ok: false, motivo: "sem_resposta" };
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("resposta de comando do picking não é objeto");
  if (typeof data.ok !== "boolean") throw new Error('resposta de comando do picking sem "ok" booleano');
  return {
    ok: data.ok,
    motivo: texto(data, "motivo"),
    atribuicao_id: texto(data, "atribuicao_id"),
    tarefa_revisao: numero(data, "tarefa_revisao"),
    estado_seq: numero(data, "estado_seq"),
  };
}

/**
 * jsonb de `ensure_picking_task_for_sales_order` (v1). Em prod todo ramo devolve `task_id` e
 * `created`; chave ausente ou de outro tipo LANÇA (o toast "enviado/já estava" depende de `created`).
 */
export function lerEnvioSeparacao(data: Json | null): { task_id: string; created: boolean } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("resposta de envio para separação não é objeto");
  }
  const { task_id, created } = data;
  if (typeof task_id !== "string") throw new Error('resposta de envio para separação sem "task_id"');
  if (typeof created !== "boolean") throw new Error('resposta de envio para separação sem "created" booleano');
  return { task_id, created };
}
