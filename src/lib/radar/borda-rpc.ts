// Borda das RPCs de escrita do radar: devolvem `jsonb` (`Json` no gerador), montado por
// `jsonb_build_object` na prod. Antes um cast duplo afirmava a forma; aqui ela é conferida e
// desvio LANÇA (a mutation vira erro — nunca "registrado" sem a resposta que o prova).
import type { Json } from '@/integrations/supabase/types';

function objeto(v: Json, fonte: string): { [chave: string]: Json | undefined } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${fonte}: resposta não é objeto`);
  return v;
}

/** `registrar_contato_radar` / `radar_atribuir_tarefa`: `{id, deduped}`. */
export function lerRegistroComDedupe(v: Json, fonte: string): { id: string; deduped: boolean } {
  const { id, deduped } = objeto(v, fonte);
  if (typeof id !== 'string' || typeof deduped !== 'boolean') {
    throw new Error(`${fonte}: resposta fora da forma {id, deduped}`);
  }
  return { id, deduped };
}

/**
 * `registrar_contato_radar` (pacote G, migration 20261111100000): `{id, deduped, nota_gravada, retorno_em}`.
 * `notaGravada` e `retornoEm` são `null` no banco anterior (só `{id, deduped}`) — quem lê decide o que isso quer dizer
 * (a ficha trata a dedupe com nota como NÃO gravada, a regra de antes). Nunca se fabrica `true`.
 */
export function lerRegistroContato(v: Json, fonte: string): {
  id: string; deduped: boolean; notaGravada: boolean | null; retornoEm: string | null;
} {
  const { id, deduped } = lerRegistroComDedupe(v, fonte);
  const { nota_gravada, retorno_em } = objeto(v, fonte);
  if (nota_gravada !== undefined && typeof nota_gravada !== 'boolean') {
    throw new Error(`${fonte}: resposta fora da forma {nota_gravada}`);
  }
  if (retorno_em !== undefined && retorno_em !== null && (typeof retorno_em !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(retorno_em))) {
    throw new Error(`${fonte}: resposta fora da forma {retorno_em}`);
  }
  return { id, deduped, notaGravada: nota_gravada ?? null, retornoEm: (retorno_em as string | null | undefined) ?? null };
}

/**
 * `desfazer_contato_radar`: `{deleted, status_restaurado}`. Três estados em `statusRestaurado`: `true` (o contato era o
 * dono do status e ele voltou), `false` (registro removido, status preservado — outro escreveu depois) e `null`
 * (banco anterior à 20261031111000, que não informa: nunca se afirma uma coisa nem outra).
 */
export function lerDesfazer(v: Json, fonte: string): { deleted: boolean; statusRestaurado: boolean | null } {
  const { deleted, status_restaurado } = objeto(v, fonte);
  if (typeof deleted !== 'boolean') throw new Error(`${fonte}: resposta fora da forma {deleted}`);
  if (status_restaurado !== undefined && typeof status_restaurado !== 'boolean') {
    throw new Error(`${fonte}: resposta fora da forma {status_restaurado}`);
  }
  return { deleted, statusRestaurado: status_restaurado ?? null };
}
