// Borda de `get_minha_positivacao[_for]` (jsonb de `_carteira_positivacao_for_owner`): lido por forma
// no lugar do cast. NULL = sem resposta (fora do papel); contagem/receita que não é número LANÇA —
// nunca vira 0 por `Number(undefined)`.
import type { Json } from '@/integrations/supabase/types';
import {
  listaJson, numeroJson, numeroOuNuloJson, objetoJson, textoJson, textoOuNuloJson,
} from '@/lib/json-forma';
import type { ClienteAPositivar, PositivacaoResumo } from './types';

const FONTE = 'get_minha_positivacao';

function clienteDoJson(v: Json): ClienteAPositivar {
  const o = objetoJson(v, `${FONTE}.a_positivar`);
  return {
    customer_user_id: textoJson(o, 'customer_user_id', FONTE),
    nome: textoOuNuloJson(o, 'nome', FONTE),
    revenue_potential: numeroOuNuloJson(o, 'revenue_potential', FONTE),
    churn_risk: numeroOuNuloJson(o, 'churn_risk', FONTE),
    recover_score: numeroOuNuloJson(o, 'recover_score', FONTE),
    days_since_last_purchase: numeroOuNuloJson(o, 'days_since_last_purchase', FONTE),
    priority_score: numeroOuNuloJson(o, 'priority_score', FONTE),
  };
}

export function positivacaoDoJson(v: Json | null): PositivacaoResumo | null {
  if (v === null) return null;
  const o = objetoJson(v, FONTE);
  return {
    mes: textoJson(o, 'mes', FONTE),
    total_eligible: numeroJson(o, 'total_eligible', FONTE),
    positivados: numeroJson(o, 'positivados', FONTE),
    compradores_mtd: numeroJson(o, 'compradores_mtd', FONTE),
    receita_mtd: numeroJson(o, 'receita_mtd', FONTE),
    contatados_mtd: numeroJson(o, 'contatados_mtd', FONTE),
    recencia_critica: numeroJson(o, 'recencia_critica', FONTE),
    novos_clientes_positivados: numeroJson(o, 'novos_clientes_positivados', FONTE),
    a_positivar: listaJson(o.a_positivar, `${FONTE}.a_positivar`).map(clienteDoJson),
  };
}
