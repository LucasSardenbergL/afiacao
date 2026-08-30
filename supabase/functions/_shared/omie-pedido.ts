// Canon Omie pedido → campos locais (sales_orders/order_items). FONTE ÚNICA do mapeamento
// etapa→status, do subtotal-com-desconto e do snapshot items-jsonb, para o sync (omie-vendas-sync)
// e o reprocess (sync-reprocess) NÃO divergirem. Essa divergência foi a causa do #B: o reprocess
// tinha o mapa INVERTIDO (60→cancelado / 50→faturado) e reescrevia o hash_payload de identidade.
// Puro (zero Deno/DB): provado por `deno test supabase/functions/_shared/omie-pedido_test.ts`.
//
// ⚠️ omie-vendas-sync ainda mantém o mapa/subtotal/itemsJson inline (L1166-1193) — unificar num
//    follow-up. Este módulo já é a fonte canônica; o teste trava o canon contra regressão (#B).

/** Os status cujo dono é o Omie — a lista que o `sync-reprocess` ENVIA à RPC
 *  `reconciliar_pedidos_omie`, que a compara por CONJUNTO com a sua cópia canônica e LANÇA se
 *  divergir. Status app-avançado (`confirmado`, `entregue`, …) fica de fora de propósito: quem
 *  reconcilia por cima dele apaga trabalho humano. Mudar esta lista sem mudar a da migration
 *  `20260830190000_reconciliar_pedidos_omie.sql` PARA a reconciliação (22023) — fail-closed, não
 *  silencioso. */
export const STATUS_GERIDO_OMIE: readonly string[] = [
  "importado",
  "separacao",
  "enviado",
  "faturado",
  "cancelado",
];
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

// ── Contrato do payload da RPC `reconciliar_pedidos_omie` (migration 20260830190000) ──────────
//
// O diff de itens NÃO mora mais aqui. Ele foi para dentro da RPC de propósito, e a razão é
// atomicidade, não arrumação: um diff computado no TS nasce de um SELECT que aconteceu FORA da
// transação de escrita. Entre a leitura e a aplicação, um item que nascesse não estaria nem em
// `inserir` nem em `deletar` e SOBREVIVERIA — a revisão aplicada seria "a nova, mais um estranho".
// Atômica e errada. A RPC recebe o conjunto DESEJADO e reconcilia contra o estado que ela mesma
// enxerga sob `FOR UPDATE` do pai, o que também torna a chamada idempotente: rodar duas vezes com
// o mesmo payload converge. Provado em `db/test-reconciliar-pedidos-omie.sh` (56 asserts, PG17).
//
// A identidade do item DENTRO do pedido é o `omie_codigo_produto`, e o `hash_payload` que vai aqui
// é o de IDENTIDADE (`omie_<account>_<pid>_<codigo>`) — NUNCA um hash de conteúdo (foi o #B no
// nível item).

export interface ItemReconciliar {
  omie_codigo_produto: number;
  quantity: number;
  unit_price: number;
  discount: number;
  product_id: string | null;
  hash_payload: string;
}

export interface PedidoReconciliar {
  account: string;
  hash_payload: string;
  omie_pedido_id: number;
  /** `omieEtapaToStatus(etapa)` quando a etapa é conhecida; `null` quando não é — e aí a RPC
   *  mantém o status atual (precisão>recall: não rebaixa por leitura malformada). */
  status_omie: string | null;
  total: number;
  items: unknown[];
  itens: ItemReconciliar[];
}
