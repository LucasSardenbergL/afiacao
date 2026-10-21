// Leitura de `jsonb` POR FORMA, para as bordas de RPC que o gerador tipa como `Json`. Cada leitor
// confere o tipo da chave e LANÇA com a fonte e a chave quando a forma diverge — no lugar do
// cast duplo para o tipo, que aceitava qualquer coisa. NULL explícito só passa nos leitores `…OuNulo`
// (NULL é contrato; nunca vira 0 nem ""), e chave ausente conta como forma errada.
import type { Json } from '@/integrations/supabase/types';

export type ObjetoJson = { [chave: string]: Json | undefined };

export function objetoJson(v: Json | undefined, fonte: string): ObjetoJson {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${fonte}: esperava objeto`);
  return v;
}

export function listaJson(v: Json | undefined, fonte: string): Json[] {
  if (!Array.isArray(v)) throw new Error(`${fonte}: esperava array`);
  return v;
}

function forma(fonte: string, chave: string, esperado: string): Error {
  return new Error(`${fonte}: "${chave}" fora da forma (${esperado})`);
}

export function textoJson(o: ObjetoJson, chave: string, fonte: string): string {
  const v = o[chave];
  if (typeof v !== 'string') throw forma(fonte, chave, 'texto');
  return v;
}

export function textoOuNuloJson(o: ObjetoJson, chave: string, fonte: string): string | null {
  const v = o[chave];
  if (v === null || typeof v === 'string') return v;
  throw forma(fonte, chave, 'texto ou null');
}

export function numeroJson(o: ObjetoJson, chave: string, fonte: string): number {
  const v = o[chave];
  if (typeof v !== 'number') throw forma(fonte, chave, 'número');
  return v;
}

export function numeroOuNuloJson(o: ObjetoJson, chave: string, fonte: string): number | null {
  const v = o[chave];
  if (v === null || typeof v === 'number') return v;
  throw forma(fonte, chave, 'número ou null');
}

export function booleanoJson(o: ObjetoJson, chave: string, fonte: string): boolean {
  const v = o[chave];
  if (typeof v !== 'boolean') throw forma(fonte, chave, 'booleano');
  return v;
}

export function booleanoOuNuloJson(o: ObjetoJson, chave: string, fonte: string): boolean | null {
  const v = o[chave];
  if (v === null || typeof v === 'boolean') return v;
  throw forma(fonte, chave, 'booleano ou null');
}
