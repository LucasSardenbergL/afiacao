// Borda do jsonb `sales_orders.items` (e o `cabecalho` do `omie_payload`). O gerador tipa os dois como
// `Json`; antes cada tela fazia um cast duplo de `items` para o seu tipo e afirmava uma forma que ninguém
// conferia — inclusive uma (`QuoteItem.omie_codigo_produto?: string`) que a prod desmente: em
// 72.589 itens (2026-10-20) o código é sempre NÚMERO.
//
// Forma medida na prod: `descricao`, `omie_codigo_produto`, `quantidade`, `valor_unitario` em TODO
// item; `desconto` em quase todos; `codigo`/`unidade`/`product_id`/`valor_total`/`tint_*` em poucos.
// Nenhum valor NULL hoje — mas `valor_unitario` NULL é contrato (preço não sabido, nunca R$ 0,00).
import type { Json } from '@/integrations/supabase/types';

type ObjetoJson = { [chave: string]: Json | undefined };

/** Um item do jsonb `items`. `type` (não `interface`) para voltar ao banco como `Json` sem cast. */
export type ItemPedidoJson = {
  omie_codigo_produto: number;
  descricao: string;
  quantidade: number;
  /** `null` = preço NÃO SABIDO (o Omie não informou). Nunca exibir nem cobrar como R$ 0,00. */
  valor_unitario: number | null;
  /** Ausente na quase totalidade dos itens (o total é derivado); `null` = sem preço, sem total. */
  valor_total?: number | null;
  desconto?: number;
  codigo?: string;
  unidade?: string;
  product_id?: string;
  tint_cor_id?: string;
  tint_nome_cor?: string;
  tint_formula_id?: string;
  tint_price_source?: string;
  tint_discount_pct?: number;
  tint_preco_sem_desconto?: number;
};

function objeto(v: Json | undefined, fonte: string): ObjetoJson {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${fonte}: esperava objeto`);
  return v;
}

function texto(o: ObjetoJson, chave: string, fonte: string): string {
  const v = o[chave];
  if (typeof v !== 'string') throw new Error(`${fonte}: "${chave}" fora da forma (texto)`);
  return v;
}

function numero(o: ObjetoJson, chave: string, fonte: string): number {
  const v = o[chave];
  if (typeof v !== 'number') throw new Error(`${fonte}: "${chave}" fora da forma (número)`);
  return v;
}

function numeroOuNulo(o: ObjetoJson, chave: string, fonte: string): number | null {
  const v = o[chave];
  if (v === null || typeof v === 'number') return v;
  throw new Error(`${fonte}: "${chave}" fora da forma (número ou null)`);
}

/** Opcional: ausente → `undefined` (a chave continua ausente no JSON regravado); tipo trocado lança. */
function textoOpcional(o: ObjetoJson, chave: string, fonte: string): string | undefined {
  const v = o[chave];
  if (v === undefined || typeof v === 'string') return v;
  throw new Error(`${fonte}: "${chave}" fora da forma (texto)`);
}

function numeroOpcional(o: ObjetoJson, chave: string, fonte: string): number | undefined {
  const v = o[chave];
  if (v === undefined || typeof v === 'number') return v;
  throw new Error(`${fonte}: "${chave}" fora da forma (número)`);
}

/**
 * Lê UM item por forma. Chave obrigatória ausente ou tipo trocado LANÇA — quem lê para cobrar
 * (conversão, edição) falha fechado. Chaves que este tipo não conhece são PRESERVADAS: o item
 * volta ao banco na edição, e descartá-las apagaria dado.
 */
function itemPedidoDoJson(v: Json, fonte: string): ItemPedidoJson {
  const o = objeto(v, fonte);
  const valorTotal = o.valor_total === undefined ? undefined : numeroOuNulo(o, 'valor_total', fonte);
  const conhecido: ItemPedidoJson = {
    omie_codigo_produto: numero(o, 'omie_codigo_produto', fonte),
    descricao: texto(o, 'descricao', fonte),
    quantidade: numero(o, 'quantidade', fonte),
    valor_unitario: numeroOuNulo(o, 'valor_unitario', fonte),
    valor_total: valorTotal,
    desconto: numeroOpcional(o, 'desconto', fonte),
    codigo: textoOpcional(o, 'codigo', fonte),
    unidade: textoOpcional(o, 'unidade', fonte),
    product_id: textoOpcional(o, 'product_id', fonte),
    tint_cor_id: textoOpcional(o, 'tint_cor_id', fonte),
    tint_nome_cor: textoOpcional(o, 'tint_nome_cor', fonte),
    tint_formula_id: textoOpcional(o, 'tint_formula_id', fonte),
    tint_price_source: textoOpcional(o, 'tint_price_source', fonte),
    tint_discount_pct: numeroOpcional(o, 'tint_discount_pct', fonte),
    tint_preco_sem_desconto: numeroOpcional(o, 'tint_preco_sem_desconto', fonte),
  };
  // Opcionais ausentes saem do objeto (não viram chave com `undefined`): `'x' in item` segue
  // respondendo o que o banco tinha.
  for (const chave of Object.keys(conhecido) as (keyof ItemPedidoJson)[]) {
    if (conhecido[chave] === undefined) delete conhecido[chave];
  }
  return { ...o, ...conhecido };
}

/** `items` inteiro. NULL = pedido sem itens (lista vazia); qualquer outra coisa que não array lança. */
export function itensPedidoDoJson(v: Json | null, fonte: string): ItemPedidoJson[] {
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${fonte}: items não é array`);
  return v.map((item, i) => itemPedidoDoJson(item, `${fonte} item ${i}`));
}

/** O `cabecalho` do `omie_payload`: objeto livre, com `codigo_parcela` (se houver) texto. */
type CabecalhoOmieJson = { codigo_parcela?: string; [chave: string]: Json | undefined };

/** O `omie_payload` como a edição o usa: objeto livre, com `cabecalho` (se houver) também objeto. */
export type OmiePayloadJson = { cabecalho?: CabecalhoOmieJson; [chave: string]: Json | undefined };

/** NULL = pedido sem payload. Payload que não é objeto, ou `cabecalho` que não é objeto, lança. */
export function omiePayloadDoJson(v: Json | null, fonte: string): OmiePayloadJson | null {
  if (v === null) return null;
  const o = objeto(v, `${fonte}.omie_payload`);
  if (o.cabecalho === undefined) return o;
  const cabecalho = objeto(o.cabecalho, `${fonte}.omie_payload.cabecalho`);
  const codigoParcela = textoOpcional(cabecalho, 'codigo_parcela', `${fonte}.omie_payload.cabecalho`);
  return { ...o, cabecalho: codigoParcela === undefined ? cabecalho : { ...cabecalho, codigo_parcela: codigoParcela } };
}
