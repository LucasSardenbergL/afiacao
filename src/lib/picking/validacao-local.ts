// Validação LOCAL de uma leitura do picking v2 — PREVISÃO do que `picking_registrar_leitura` vai
// decidir, para o feedback sair em <50 ms sem esperar a rede. O servidor é a autoridade
// (spec §3.6.6): quando discordar, a tela corrige e avisa.
//
// Espelha, na mesma ordem, a resolução do bipe e do manual da RPC
// (supabase/migrations/20261011020000_picking_v2_schema.sql, `picking_registrar_leitura`).
// Mudou lá → muda aqui (o teste `validacao-local.test.ts` lista os motivos um a um).

export interface LinhaLocal {
  id: string;
  codigo_item: number;
  omie_codigo_produto: number;
  unidade: string;
  ean: string | null;
  quantidade: number;
  fracionaria: boolean;
  ativa: boolean;
  /** Separado na revisão vigente: servidor confirmado + leituras locais ainda na fila. */
  separada: number;
}

export interface CodigoCadastrado {
  codigo: string;
  omie_codigo_produto: number;
  unidade: string;
  unidades_por_leitura: number;
  status: "pendente" | "aprovado";
}

type MotivoRejeicao =
  | "tarefa_fora_de_separacao"
  | "codigo_pendente_aprovacao"
  | "codigo_ambiguo"
  | "codigo_desconhecido"
  | "codigo_fora_do_pedido"
  | "unidade_incompativel"
  | "linha_fracionaria_exige_manual"
  | "excesso"
  | "linha_inativa"
  | "manual_nao_permitido"
  | "quantidade_nao_inteira";

export type Previsao =
  | { ok: true; linha_id: string; unidades: number }
  | { ok: false; motivo: MotivoRejeicao; linha_id: string | null };

const saldo = (l: LinhaLocal) => l.quantidade - l.separada;

/**
 * Bipe: `cadastro` = o código em `picking_codigos_barras` da conta (não revogado), se houver.
 * Ordem igual à RPC: pendente → ambíguo (cadastro × EAN da linha) → desconhecido → ambíguo
 * (EAN em pares produto×unidade distintos) → fora do pedido → unidade → fracionária → excesso.
 */
export function preverBipe(codigo: string, linhas: LinhaLocal[], cadastro: CodigoCadastrado | null): Previsao {
  const ativas = linhas.filter((l) => l.ativa);
  const comEan = ativas.filter((l) => l.ean === codigo);
  const paresEan = new Set(comEan.map((l) => `${l.omie_codigo_produto}|${l.unidade}`));

  if (cadastro && cadastro.status !== "aprovado") return { ok: false, motivo: "codigo_pendente_aprovacao", linha_id: null };
  if (
    cadastro &&
    comEan.some((l) => l.omie_codigo_produto !== cadastro.omie_codigo_produto || l.unidade !== cadastro.unidade || cadastro.unidades_por_leitura !== 1)
  ) {
    return { ok: false, motivo: "codigo_ambiguo", linha_id: null };
  }
  if (!cadastro && paresEan.size === 0) return { ok: false, motivo: "codigo_desconhecido", linha_id: null };
  if (!cadastro && paresEan.size > 1) return { ok: false, motivo: "codigo_ambiguo", linha_id: null };
  if (cadastro && !ativas.some((l) => l.omie_codigo_produto === cadastro.omie_codigo_produto)) {
    return { ok: false, motivo: "codigo_fora_do_pedido", linha_id: null };
  }
  if (cadastro && !ativas.some((l) => l.omie_codigo_produto === cadastro.omie_codigo_produto && l.unidade === cadastro.unidade)) {
    return { ok: false, motivo: "unidade_incompativel", linha_id: null };
  }

  const fator = cadastro ? cadastro.unidades_por_leitura : 1;
  const candidatas = ativas
    .filter((l) => !l.fracionaria)
    .filter((l) => (cadastro ? l.omie_codigo_produto === cadastro.omie_codigo_produto && l.unidade === cadastro.unidade : l.ean === codigo))
    .sort((a, b) => a.codigo_item - b.codigo_item);
  if (candidatas.length === 0) return { ok: false, motivo: "linha_fracionaria_exige_manual", linha_id: null };
  const linha = candidatas.find((l) => saldo(l) > 0);
  if (!linha) return { ok: false, motivo: "excesso", linha_id: null };
  if (fator > saldo(linha)) return { ok: false, motivo: "excesso", linha_id: linha.id };
  return { ok: true, linha_id: linha.id, unidades: fator };
}

/**
 * Manual: só em linha fracionária, ou em linha sem código conhecido (sem EAN e sem código
 * aprovado do produto NA UNIDADE da linha). `aprovadosDoProduto` = códigos aprovados da conta
 * para o produto da linha.
 */
export function preverManual(linha: LinhaLocal, quantidade: number, aprovadosDoProduto: CodigoCadastrado[]): Previsao {
  if (!linha.ativa) return { ok: false, motivo: "linha_inativa", linha_id: linha.id };
  const temCodigo =
    linha.ean !== null ||
    aprovadosDoProduto.some((c) => c.status === "aprovado" && c.omie_codigo_produto === linha.omie_codigo_produto && c.unidade === linha.unidade);
  if (!linha.fracionaria && temCodigo) return { ok: false, motivo: "manual_nao_permitido", linha_id: linha.id };
  if (!linha.fracionaria && !Number.isInteger(quantidade)) return { ok: false, motivo: "quantidade_nao_inteira", linha_id: linha.id };
  if (quantidade > saldo(linha)) return { ok: false, motivo: "excesso", linha_id: linha.id };
  return { ok: true, linha_id: linha.id, unidades: quantidade };
}
