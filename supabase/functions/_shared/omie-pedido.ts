// Canon Omie pedido → campos locais (sales_orders/order_items). FONTE ÚNICA do mapeamento
// etapa→status, do subtotal-com-desconto e do snapshot items-jsonb, para o sync (omie-vendas-sync)
// e o reprocess (sync-reprocess) NÃO divergirem. Essa divergência foi a causa do #B: o reprocess
// tinha o mapa INVERTIDO (60→cancelado / 50→faturado) e reescrevia o hash_payload de identidade.
// Puro (zero Deno/DB): provado por `deno test supabase/functions/_shared/omie-pedido_test.ts`.
//
// ⚠️ omie-vendas-sync ainda mantém o mapa/subtotal/itemsJson inline (L1166-1193) — unificar num
//    follow-up. Este módulo já é a fonte canônica; o teste trava o canon contra regressão (#B).

const STATUS_OMIE = new Set(["importado", "separacao", "enviado", "faturado", "cancelado"]);
const ETAPAS_CONHECIDAS = new Set(["20", "50", "60", "70", "80"]);

/** etapa (cabecalho.etapa do Omie) → status local. Default 'importado' (etapa 10/desconhecida). */
export function omieEtapaToStatus(etapa: string | undefined | null): string {
  const e = etapa || "";
  if (e === "60" || e === "70") return "faturado";
  if (e === "50") return "separacao";
  if (e === "20") return "enviado";
  if (e === "80") return "cancelado";
  return "importado";
}

/** etapa reconhecida? O reprocess só reconcilia status com etapa CONHECIDA — não rebaixa para
 *  'importado' a partir de uma leitura malformada/sem etapa (precisão>recall). */
export function etapaConhecida(etapa: string | undefined | null): boolean {
  return ETAPAS_CONHECIDAS.has(etapa || "");
}

/** status local é gerido pelo Omie? O reprocess NÃO sobrescreve status app-avançado
 *  (confirmado/entregue/rascunho/pendente…) — só reconcilia quando o local veio do mapa do Omie. */
export function statusEhOmie(status: string | undefined | null): boolean {
  return STATUS_OMIE.has(status || "");
}

interface DetInput {
  produto?: {
    codigo_produto?: number | string;
    descricao?: string;
    quantidade?: number;
    valor_unitario?: number;
    desconto?: number;
  };
  observacao?: { obs_item?: string };
  inf_adic?: { dados_adicionais_item?: string };
}

/** subtotal = Σ qty·preço·(1 − desconto%/100), arredondado a 2 casas. `desconto` é PERCENTUAL.
 *  MESMA semântica do omie-vendas-sync (L1170-1173): `|| ` (qty 0 → 1, igual ao sync) — NÃO `??`. */
export function subtotalPedidoComDesconto(det: DetInput[]): number {
  let subtotal = 0;
  for (const d of det) {
    const prod = d.produto || {};
    const qty = prod.quantidade || 1;
    const price = prod.valor_unitario || 0;
    const desc = prod.desconto || 0;
    subtotal += qty * price * (1 - desc / 100);
  }
  return Math.round(subtotal * 100) / 100;
}

/** Cor de tinta a partir da obs do item ("Cor: <label> - <embalagem>"). Espelha o parseCorObs do
 *  omie-vendas-sync verbatim (a cor vai em obs_item na ida; o sync extrai de volta). */
function parseCorObs(obs: string | null | undefined): { tint_nome_cor: string } | null {
  if (!obs) return null;
  const m = /^\s*cor:\s*(.+)$/i.exec(obs);
  if (!m) return null;
  const label = m[1].replace(/\s*-\s*(?:QT|GL|LT|\d+(?:[.,]\d+)?\s*ML)\s*$/i, "").trim();
  if (!label) return null;
  return { tint_nome_cor: label };
}

interface ItemJson {
  omie_codigo_produto: number | string | undefined;
  descricao: string;
  quantidade: number;
  valor_unitario: number;
  desconto: number;
  tint_nome_cor?: string;
}

/** Reconstrói o snapshot sales_orders.items (jsonb) IGUAL ao omie-vendas-sync (L1178-1185):
 *  mesmas chaves, desconto bruto, cor de tinta da obs. Mantém os MUITOS leitores de items-jsonb
 *  (scoring/cross-sell/bundle/UI/print) consistentes com order_items após o reconcile (achado #B
 *  Codex A2 — o reprocess antigo atualizava order_items mas deixava items-jsonb stale). */
export function construirItemsJson(det: DetInput[]): ItemJson[] {
  const out: ItemJson[] = [];
  for (const d of det) {
    const prod = d.produto || {};
    const cor = parseCorObs(d.observacao?.obs_item ?? d.inf_adic?.dados_adicionais_item);
    out.push({
      omie_codigo_produto: prod.codigo_produto,
      descricao: prod.descricao || "",
      quantidade: prod.quantidade || 1,
      valor_unitario: prod.valor_unitario || 0,
      desconto: prod.desconto || 0,
      ...(cor ? { tint_nome_cor: cor.tint_nome_cor } : {}),
    });
  }
  return out;
}

// ── Reconciliação de itens (order_items) por IDENTIDADE (omie_codigo_produto), preservando o
//    hash_payload de identidade `omie_<account>_<pid>_<codigo>` — NUNCA reescrever p/ hash de
//    conteúdo (foi o #B no nível item). Itens inseridos/atualizados carregam o hash de identidade;
//    item pré-existente inalterado mantém o seu hash legado (INERTE — não é lido p/ idempotência:
//    a RPC do sync não re-insere itens de pedido existente). ──

export interface ItemLocal {
  id: string;
  omie_codigo_produto: number;
  quantity: number;
  unit_price: number;
  discount: number;
  product_id: string | null;
}
export interface ItemDesejado {
  omie_codigo_produto: number;
  quantity: number;
  unit_price: number;
  discount: number;
  product_id: string | null;
  hash_payload: string;
}
interface ItemUpdate {
  id: string;
  quantity: number;
  unit_price: number;
  discount: number;
  product_id: string | null;
  hash_payload: string; // A3: o update repara a identidade do item
}
interface DiffItens {
  inserir: ItemDesejado[];
  atualizar: ItemUpdate[];
  deletar: string[]; // ids dos order_items a remover
}

const EPS = 1e-6;
function numEq(a: number, b: number): boolean {
  return Math.abs((a ?? 0) - (b ?? 0)) < EPS;
}

/**
 * Diff de itens por omie_codigo_produto (chave de identidade dentro do pedido):
 *  - inserir   = no Omie e SEM correspondente local (carrega o hash de identidade);
 *  - atualizar = local com CONTEÚDO divergente (qty/preço/desconto/product_id) → grava o conteúdo
 *                novo E o hash de identidade (repara hash legado de conteúdo de passada);
 *  - deletar   = local SEM correspondente no Omie (item REMOVIDO — o reprocess antigo nunca
 *                deletava → total/positivação inflados por item fantasma).
 * Conteúdo igual ⇒ no-op (não dispara update só por hash → evita burst de reescrita inerte).
 * Premissa de codigo_produto único no pedido (mesma do sync); o caller PULA o reconcile de itens
 * quando o Omie repete um SKU (ambíguo) p/ não deletar linha legítima.
 */
export function diffOrderItens(locais: ItemLocal[], desejados: ItemDesejado[]): DiffItens {
  const mapLocal = new Map<number, ItemLocal>();
  for (const l of locais) mapLocal.set(l.omie_codigo_produto, l);
  const mapDesejado = new Map<number, ItemDesejado>();
  for (const d of desejados) mapDesejado.set(d.omie_codigo_produto, d);

  const inserir: ItemDesejado[] = [];
  const atualizar: ItemUpdate[] = [];
  const deletar: string[] = [];

  for (const d of mapDesejado.values()) {
    const l = mapLocal.get(d.omie_codigo_produto);
    if (!l) {
      inserir.push(d);
      continue;
    }
    const igual = numEq(l.quantity, d.quantity)
      && numEq(l.unit_price, d.unit_price)
      && numEq(l.discount, d.discount)
      && (l.product_id ?? null) === (d.product_id ?? null);
    if (!igual) {
      atualizar.push({
        id: l.id,
        quantity: d.quantity,
        unit_price: d.unit_price,
        discount: d.discount,
        product_id: d.product_id,
        hash_payload: d.hash_payload,
      });
    }
  }
  for (const l of mapLocal.values()) {
    if (!mapDesejado.has(l.omie_codigo_produto)) deletar.push(l.id);
  }
  return { inserir, atualizar, deletar };
}
