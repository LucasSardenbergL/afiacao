// Borda entre o `jsonb` das RPCs `get_tint_price` (single) / `get_tint_prices` (batch) e os tipos
// de preço do balcão. Antes era `data as unknown as TintPriceBreakdown` — cast que fingia a forma
// e, pior, fingia que `custoBase`/`custoCorantes` são sempre número: a RPC devolve NULL fora do
// staff (gate de custo, P1 20260708234100). Aqui a forma é LIDA campo a campo e qualquer desvio
// LANÇA: o react-query expõe `isError`, o balcão fica SEM preço (fail-closed, money-path) —
// nunca `Number(null) === 0`, nunca preço fabricado de uma resposta que não entendemos.
import type { Json } from '@/integrations/supabase/types';
import type { TintPriceBreakdown } from './compute-price';
import type { TintPriceBreakdownLite } from './select-price';

/** O que `get_tint_price` devolve DE FATO: o agregado (Lite) + a receita (vazia fora do staff). */
export type TintPrecoRpc = TintPriceBreakdownLite & { itensCorantes: TintPriceBreakdown['itensCorantes'] };

type Objeto = { [key: string]: Json | undefined };

function objeto(j: Json | undefined, fonte: string): Objeto {
  if (j === null || j === undefined || typeof j !== 'object' || Array.isArray(j)) {
    throw new Error(`${fonte}: resposta não é objeto`);
  }
  return j;
}

// NULL EXPLÍCITO é contrato (custo oculto fora do staff); chave AUSENTE é forma desconhecida e LANÇA
// — senão `{baseDisponivel, corantesCompletos, precoFinal}` sem os custos liberaria preço (Codex, PR 4).
function numeroOuNull(o: Objeto, campo: string, fonte: string): number | null {
  if (!(campo in o) || o[campo] === undefined) throw new Error(`${fonte}: ${campo} ausente`);
  const v = o[campo];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${fonte}: ${campo} não é número`);
  return v;
}

function numero(o: Objeto, campo: string, fonte: string): number {
  const v = numeroOuNull(o, campo, fonte);
  if (v === null) throw new Error(`${fonte}: ${campo} veio nulo`);
  return v;
}

function booleano(o: Objeto, campo: string, fonte: string): boolean {
  const v = o[campo];
  if (typeof v !== 'boolean') throw new Error(`${fonte}: ${campo} não é booleano`);
  return v;
}

function texto(o: Objeto, campo: string, fonte: string): string {
  const v = o[campo];
  if (typeof v !== 'string') throw new Error(`${fonte}: ${campo} não é texto`);
  return v;
}

function liteDeObjeto(o: Objeto, fonte: string): TintPriceBreakdownLite {
  return {
    custoBase: numeroOuNull(o, 'custoBase', fonte),
    baseDisponivel: booleano(o, 'baseDisponivel', fonte),
    custoCorantes: numeroOuNull(o, 'custoCorantes', fonte),
    corantesCompletos: booleano(o, 'corantesCompletos', fonte),
    precoFinal: numeroOuNull(o, 'precoFinal', fonte),
  };
}

function itemDeJson(j: Json | undefined, fonte: string): TintPrecoRpc['itensCorantes'][number] {
  const o = objeto(j, fonte);
  return {
    coranteDescricao: texto(o, 'coranteDescricao', fonte),
    qtdMl: numero(o, 'qtdMl', fonte),
    custoPorMl: numero(o, 'custoPorMl', fonte),
    custoItem: numero(o, 'custoItem', fonte),
    custoDisponivel: booleano(o, 'custoDisponivel', fonte),
  };
}

/** `get_tint_price` → breakdown single (receita `[]` fora do staff — a RPC já gateia). */
export function precoDeJson(json: Json): TintPrecoRpc {
  const fonte = 'get_tint_price';
  const o = objeto(json, fonte);
  const itens = o.itensCorantes;
  if (!Array.isArray(itens)) throw new Error(`${fonte}: itensCorantes não é lista`);
  return { ...liteDeObjeto(o, fonte), itensCorantes: itens.map((i) => itemDeJson(i, `${fonte}.itensCorantes`)) };
}

/** `get_tint_prices` → `{ formulaId: breakdown lite }` (`{}` quando nenhuma fórmula entrou). */
export function precosDeJson(json: Json): Record<string, TintPriceBreakdownLite> {
  const fonte = 'get_tint_prices';
  const o = objeto(json, fonte);
  const out: Record<string, TintPriceBreakdownLite> = {};
  for (const [id, v] of Object.entries(o)) {
    out[id] = liteDeObjeto(objeto(v, `${fonte}[${id}]`), `${fonte}[${id}]`);
  }
  return out;
}
