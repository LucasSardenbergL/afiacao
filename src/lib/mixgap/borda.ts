// Borda de `get_meu_mixgap[_for]` (jsonb): lido por forma no lugar do cast. NULL = sem resposta (a RPC
// devolve NULL fora do papel); forma divergente LANÇA.
import type { Json } from '@/integrations/supabase/types';
import { listaJson, numeroJson, objetoJson, textoJson, textoOuNuloJson } from '@/lib/json-forma';
import type { GapCliente, MixGapResumo } from './types';

const FONTE = 'get_meu_mixgap';

function gapDoJson(v: Json): GapCliente {
  const o = objetoJson(v, `${FONTE}.lista`);
  const feedback = o.feedback_status;
  if (!(feedback === undefined || feedback === null || feedback === 'ofertado')) {
    throw new Error(`${FONTE}: "feedback_status" fora do vocabulário (${String(feedback)})`);
  }
  return {
    customer_user_id: textoJson(o, 'customer_user_id', FONTE),
    nome: textoOuNuloJson(o, 'nome', FONTE),
    familia_faltante: textoJson(o, 'familia_faltante', FONTE),
    confidence: numeroJson(o, 'confidence', FONTE),
    lift: numeroJson(o, 'lift', FONTE),
    evidence_count: numeroJson(o, 'evidence_count', FONTE),
    ...(feedback === undefined ? {} : { feedback_status: feedback }),
  };
}

export function mixGapDoJson(v: Json | null): MixGapResumo | null {
  if (v === null) return null;
  const o = objetoJson(v, FONTE);
  return {
    total_com_gap: numeroJson(o, 'total_com_gap', FONTE),
    // `lista` NULL era tratado como vazia pelo consumidor (`r.lista ?? []`): mantido.
    lista: o.lista === null ? [] : listaJson(o.lista, `${FONTE}.lista`).map(gapDoJson),
  };
}
