// Ordem de produção honesta (PR 8.4 da rodada 3 do Novo Pedido) — regras PURAS de `criar_ordem_producao`.
//
// Antes: o `catch` do `IncluirOrdemProducao` só logava, a linha local nascia com `omie_ordem_numero = "null"`
// (`String(null)`) e a resposta era `{ success: true }` incondicional — o vendedor via "OP criada" para uma
// OP que o Omie recusou. E chamar de novo duplicava a linha local (o Omie recusa o 2º `cCodIntOP`, então
// a 2ª linha nascia sem OP).
//
// Agora:
//   • cada item tem DESFECHO (`criada` · `ja_existia` · `falhou` com o motivo) e `success` só é true sem falha;
//   • a chamada é IDEMPOTENTE pela linha local do (pedido, conta, produto): com OP no Omie → `ja_existia`
//     (não chama o Omie); sem OP → reenvia e ATUALIZA a mesma linha (retoma só o que falhou); sem linha → cria;
//   • o mesmo produto em duas linhas do carrinho vira UMA OP com a soma (o `cCodIntOP` é por produto: a
//     2ª chamada era recusada e a quantidade dela sumia da produção).
//
// Testado em ./ordem-producao_test.ts.

export interface ItemOp {
  product_id?: string | null;
  omie_codigo_produto?: number;
  codigo?: string;
  descricao?: string;
  quantidade: number;
  unidade?: string;
  assigned_to?: string | null;
  ready_by_date?: string | null;
}

export interface LinhaOpLocal {
  id: string;
  product_id: string | null;
  product_codigo: string | null;
  omie_ordem_producao_id: number | null;
  omie_ordem_numero: string | null;
}

export type DesfechoOp =
  | { status: "criada"; omie_ordem_id: number; omie_ordem_numero: string }
  | { status: "ja_existia"; omie_ordem_id: number; omie_ordem_numero: string | null }
  | { status: "falhou"; motivo: string };

/** Chave do produto no Omie — a mesma do `cCodIntOP`. Ausente/0 = sem chave (não fabricar). */
function chaveProduto(item: ItemOp): number | null {
  const c = item.omie_codigo_produto;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : null;
}

/**
 * Junta as linhas do MESMO produto numa só (soma a quantidade; a data prometida mais CEDO vale para a
 * OP, que é a que a produção precisa cumprir). Itens sem código Omie seguem sozinhos (vão falhar honesto).
 */
export function agruparItensOp(itens: ItemOp[]): ItemOp[] {
  const saida: ItemOp[] = [];
  const porChave = new Map<number, ItemOp>();
  for (const it of itens) {
    const k = chaveProduto(it);
    if (k === null) { saida.push({ ...it }); continue; }
    const ja = porChave.get(k);
    if (!ja) {
      const novo = { ...it };
      porChave.set(k, novo);
      saida.push(novo);
      continue;
    }
    ja.quantidade = ja.quantidade + it.quantidade;
    const d = it.ready_by_date || null;
    if (d && (!ja.ready_by_date || d < ja.ready_by_date)) ja.ready_by_date = d;
  }
  return saida;
}

/**
 * A linha local que já representa este item no pedido: pelo `product_id`; pelo código do produto só
 * quando um dos lados não tem `product_id` (nunca casa dois `product_id` diferentes pelo código).
 */
export function linhaDoItem(item: ItemOp, linhas: LinhaOpLocal[]): LinhaOpLocal | undefined {
  if (item.product_id) {
    const porId = linhas.find((l) => l.product_id === item.product_id);
    if (porId) return porId;
  }
  if (!item.codigo) return undefined;
  return linhas.find((l) =>
    l.product_codigo === item.codigo && (!item.product_id || l.product_id == null)
  );
}

export type PlanoOp =
  | { acao: "pular"; linha: LinhaOpLocal }
  | { acao: "reenviar"; linha: LinhaOpLocal }
  | { acao: "criar" };

/** O que fazer com o item: já tem OP no Omie → pular; tem linha sem OP → reenviar nela; nada → criar. */
export function planoDoItem(item: ItemOp, linhas: LinhaOpLocal[]): PlanoOp {
  const linha = linhaDoItem(item, linhas);
  if (!linha) return { acao: "criar" };
  return linha.omie_ordem_producao_id ? { acao: "pular", linha } : { acao: "reenviar", linha };
}

/** Lê o `nCodOP`/`cNumOP` da resposta do `IncluirOrdemProducao`. Sem `nCodOP` válido = NÃO criou. */
export function lerRespostaOp(r: unknown): { id: number; numero: string } | null {
  if (!r || typeof r !== "object") return null;
  const o = r as { nCodOP?: unknown; cNumOP?: unknown };
  const id = typeof o.nCodOP === "number" ? o.nCodOP : typeof o.nCodOP === "string" ? Number(o.nCodOP) : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;
  const numero = typeof o.cNumOP === "string" && o.cNumOP.trim() ? o.cNumOP.trim() : String(id);
  return { id, numero };
}

/** Pré-condição local antes de chamar o Omie; `null` = pode chamar. */
export function motivoParaNaoChamar(item: ItemOp): string | null {
  if (chaveProduto(item) === null) return "produto sem código no Omie";
  if (!(typeof item.quantidade === "number" && Number.isFinite(item.quantidade) && item.quantidade > 0)) {
    return "quantidade inválida";
  }
  return null;
}

export function resumoOps(desfechos: DesfechoOp[]): { success: boolean; falhas: number } {
  const falhas = desfechos.filter((d) => d.status === "falhou").length;
  return { success: falhas === 0, falhas };
}
