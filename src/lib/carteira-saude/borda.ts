// Borda de `get_carteira_saude` (jsonb): lido por forma no lugar do cast. NULL = sem resposta (RPC
// devolve NULL sem permissão); forma divergente LANÇA (o painel mostra a falha, não um verde falso).
import type { Json } from '@/integrations/supabase/types';
import {
  listaJson, numeroJson, numeroOuNuloJson, objetoJson, textoJson, textoOuNuloJson,
} from '@/lib/json-forma';
import type { CarteiraSaudeResumo, CronSaude } from './types';

const FONTE = 'get_carteira_saude';

function cronDoJson(v: Json): CronSaude {
  const o = objetoJson(v, `${FONTE}.crons`);
  return {
    jobname: textoJson(o, 'jobname', FONTE),
    last_status: textoOuNuloJson(o, 'last_status', FONTE),
    last_run_at: textoOuNuloJson(o, 'last_run_at', FONTE),
    age_hours: numeroOuNuloJson(o, 'age_hours', FONTE),
    last_error: textoOuNuloJson(o, 'last_error', FONTE),
  };
}

export function carteiraSaudeDoJson(v: Json | null): CarteiraSaudeResumo | null {
  if (v === null) return null;
  const o = objetoJson(v, FONTE);
  const sync = objetoJson(o.sync, `${FONTE}.sync`);
  const cobertura = objetoJson(o.score_coverage, `${FONTE}.score_coverage`);
  return {
    crons: listaJson(o.crons, `${FONTE}.crons`).map(cronDoJson),
    sync: {
      max_last_synced_at: textoOuNuloJson(sync, 'max_last_synced_at', FONTE),
      age_hours: numeroOuNuloJson(sync, 'age_hours', FONTE),
      stale_count: numeroJson(sync, 'stale_count', FONTE),
    },
    score_coverage: {
      carteira: numeroJson(cobertura, 'carteira', FONTE),
      fcs_clientes: numeroJson(cobertura, 'fcs_clientes', FONTE),
      cvs_clientes: numeroJson(cobertura, 'cvs_clientes', FONTE),
    },
  };
}
