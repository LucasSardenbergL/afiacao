// Borda das RPCs da régua (`get_regua_preco`, `get_regua_preco_customer360`): as duas devolvem
// `jsonb`, que o gerador tipa como `Json`. Antes, um cast duplo do `supabase.rpc` afirmava
// `FetchDataRegua`/`FetchData360[]` sem conferir; aqui o pacote é lido por forma, contra o
// `jsonb_build_object` de prod. NULL explícito continua NULL (número mascarado sem capability ≠ 0).
import type { Json } from '@/integrations/supabase/types';
import type { FetchData360, FetchDataRegua } from './regua-preco-ui';

type ObjetoJson = { [chave: string]: Json | undefined };

function objeto(v: Json | undefined, fonte: string): ObjetoJson {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${fonte}: esperava objeto`);
  return v;
}

function bool(o: ObjetoJson, chave: string, fonte: string): boolean {
  const v = o[chave];
  if (typeof v !== 'boolean') throw new Error(`${fonte}: "${chave}" fora da forma (booleano)`);
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

/** Chave que o 360 OMITE por desenho conforme `hide_reason` (sem_produto/sem_preco/…): ausente → null. */
function opcional<T extends Json>(o: ObjetoJson, chave: string, ok: (v: Json) => v is T, forma: string, fonte: string): T | null {
  const v = o[chave];
  if (v === undefined || v === null) return null;
  if (!ok(v)) throw new Error(`${fonte}: "${chave}" fora da forma (${forma})`);
  return v;
}
const ehTexto = (v: Json): v is string => typeof v === 'string';
const ehNumero = (v: Json): v is number => typeof v === 'number';

function listaDe<T>(v: Json | undefined, ler: (item: Json) => T, chave: string, fonte: string): T[] {
  if (!Array.isArray(v)) throw new Error(`${fonte}: "${chave}" fora da forma (array)`);
  return v.map(ler);
}

/** O pacote de `get_regua_preco`: as 8 chaves vêm sempre (as listas com `COALESCE(…, '[]')`). */
export function fetchDataReguaDoJson(v: Json | undefined, fonte = 'get_regua_preco'): FetchDataRegua {
  const o = objeto(v, fonte);
  return {
    abaixo_piso: bool(o, 'abaixo_piso', fonte),
    piso_disponivel: bool(o, 'piso_disponivel', fonte),
    cmc_confiavel: bool(o, 'cmc_confiavel', fonte),
    prazo_aplicado: bool(o, 'prazo_aplicado', fonte),
    piso_mc: numeroOuNulo(o, 'piso_mc', fonte),
    piso_gap_pct: numeroOuNulo(o, 'piso_gap_pct', fonte),
    precos_cliente: listaDe(
      o.precos_cliente,
      (p) => {
        if (typeof p !== 'number') throw new Error(`${fonte}: "precos_cliente" com item não numérico`);
        return p;
      },
      'precos_cliente',
      fonte,
    ),
    comparaveis: listaDe(
      o.comparaveis,
      (c) => {
        const item = objeto(c, `${fonte}.comparaveis`);
        return { preco: numero(item, 'preco', fonte), c: numero(item, 'c', fonte) };
      },
      'comparaveis',
      fonte,
    ),
  };
}

/**
 * Um item de `get_regua_preco_customer360`: o descritor 360 + (quando houve quantidade de
 * referência) o pacote inteiro da `get_regua_preco` mesclado por `||`. Sem pacote, os campos da
 * régua ficam ausentes — o `Partial` do tipo — e o descritor omitido vira null.
 */
function fetchData360DoJson(v: Json): FetchData360 {
  const fonte = 'get_regua_preco_customer360';
  const o = objeto(v, fonte);
  const descritor = {
    omie_codigo: numero(o, 'omie_codigo', fonte),
    product_id: opcional(o, 'product_id', ehTexto, 'texto', fonte),
    preco_atual: opcional(o, 'preco_atual', ehNumero, 'número', fonte),
    preco_atual_at: opcional(o, 'preco_atual_at', ehTexto, 'texto', fonte),
    qty_ref: opcional(o, 'qty_ref', ehNumero, 'número', fonte),
    qty_ref_source: opcional(o, 'qty_ref_source', ehTexto, 'texto', fonte),
    hide_reason: opcional(o, 'hide_reason', ehTexto, 'texto', fonte),
  };
  return 'abaixo_piso' in o ? { ...fetchDataReguaDoJson(o, fonte), ...descritor } : descritor;
}

export function fetchDatas360DoJson(v: Json): FetchData360[] {
  if (!Array.isArray(v)) throw new Error('get_regua_preco_customer360: retorno não é array');
  return v.map(fetchData360DoJson);
}
