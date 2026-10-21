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

/** `desfazer_contato_radar`: `{deleted}`. */
export function lerDesfazer(v: Json, fonte: string): { deleted: boolean } {
  const { deleted } = objeto(v, fonte);
  if (typeof deleted !== 'boolean') throw new Error(`${fonte}: resposta fora da forma {deleted}`);
  return { deleted };
}
