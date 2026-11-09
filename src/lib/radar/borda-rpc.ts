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
 * `registrar_contato_radar` (pacote G, migration 20261111100000): `{id, deduped, nota_gravada, retorno_em}`; o
 * pacote L (20261111134000) acrescenta `posse` (ver `PosseDoContato`).
 * `notaGravada` e `retornoEm` são `null` no banco anterior (só `{id, deduped}`) — quem lê decide o que isso quer dizer
 * (a ficha trata a dedupe com nota como NÃO gravada, a regra de antes). Nunca se fabrica `true`.
 */
export function lerRegistroContato(v: Json, fonte: string): {
  id: string; deduped: boolean; notaGravada: boolean | null; retornoEm: string | null; posse: PosseDoContato | null;
} {
  const { id, deduped } = lerRegistroComDedupe(v, fonte);
  const { nota_gravada, retorno_em, posse } = objeto(v, fonte);
  if (nota_gravada !== undefined && typeof nota_gravada !== 'boolean') {
    throw new Error(`${fonte}: resposta fora da forma {nota_gravada}`);
  }
  if (retorno_em !== undefined && retorno_em !== null && (typeof retorno_em !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(retorno_em))) {
    throw new Error(`${fonte}: resposta fora da forma {retorno_em}`);
  }
  return {
    id, deduped, notaGravada: nota_gravada ?? null, retornoEm: (retorno_em as string | null | undefined) ?? null,
    posse: lerPosseDoContato(posse),
  };
}

/**
 * Pacote L (migration 20261111134000): o que o registro fez com a POSSE do lead — a resposta de
 * `radar_definir_atendimento('assumir')` chamado por dentro do registro. `null` = não mexeu (descarte, clique
 * repetido) ou o banco é anterior ao pacote L (não diz). Diferente do resto da resposta, forma inesperada aqui NÃO
 * lança: o contato já foi gravado (é isso que `id` prova) e transformar isso em erro faria o vendedor repetir um
 * registro que existe. Degrada para `null` — "não sei o que aconteceu com a posse", nunca "ficou com você".
 */
export type PosseDoContato =
  | { ok: true; renovado: boolean; expiraEm: string | null }
  | { ok: false; motivo: string; donoNome: string | null; expiraEm: string | null };

function lerPosseDoContato(v: Json | undefined): PosseDoContato | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const expira = typeof v.expira_em === 'string' && !Number.isNaN(Date.parse(v.expira_em)) ? v.expira_em : null;
  if (v.ok === true && typeof v.renovado === 'boolean') return { ok: true, renovado: v.renovado, expiraEm: expira };
  if (v.ok === false && typeof v.motivo === 'string') {
    return { ok: false, motivo: v.motivo, donoNome: typeof v.dono_nome === 'string' ? v.dono_nome : null, expiraEm: expira };
  }
  return null;
}

/**
 * `desfazer_contato_radar`: `{deleted, status_restaurado}`. Três estados em `statusRestaurado`: `true` (o contato era o
 * dono do status e ele voltou), `false` (registro removido, status preservado — outro escreveu depois) e `null`
 * (banco anterior à 20261031111000, que não informa: nunca se afirma uma coisa nem outra).
 */
export function lerDesfazer(v: Json, fonte: string): {
  deleted: boolean; statusRestaurado: boolean | null; posseDesfeita: boolean;
} {
  const { deleted, status_restaurado, posse_desfeita } = objeto(v, fonte);
  if (typeof deleted !== 'boolean') throw new Error(`${fonte}: resposta fora da forma {deleted}`);
  if (status_restaurado !== undefined && typeof status_restaurado !== 'boolean') {
    throw new Error(`${fonte}: resposta fora da forma {status_restaurado}`);
  }
  // Pacote L: a posse que o contato desfeito criou foi fechada junto. Ausente (banco anterior) = não afirmo.
  return { deleted, statusRestaurado: status_restaurado ?? null, posseDesfeita: posse_desfeita === true };
}
