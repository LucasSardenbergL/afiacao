// Borda de `ai_decisions` → `AIDecision`. Os dois jsonb (`evidences`, `customer_metrics`) chegam
// como `Json | null`; antes um cast duplo para `AIDecision[]` fingia a forma e um `as Evidence[]` no
// card fazia `.slice` sobre o que viesse. Aqui eles são lidos POR FORMA.
import type { Json, Tables } from '@/integrations/supabase/types';
import type { AIDecision, Evidence } from './types';

const TIPOS_EVIDENCIA: readonly Evidence['type'][] = ['warning', 'info', 'critical'];

function ehObjeto(v: Json | undefined): v is { [chave: string]: Json | undefined } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function evidenciaDoJson(v: Json, id: string): Evidence {
  if (ehObjeto(v)) {
    const { label, value, type } = v;
    const tipo = TIPOS_EVIDENCIA.find((t) => t === type);
    if (typeof label === 'string' && typeof value === 'string' && tipo) return { label, value, type: tipo };
  }
  throw new Error(`ai_decisions ${id}: evidência fora da forma {label, value, type}`);
}

/** NULL = decisão sem evidências (lista vazia). Qualquer outra coisa que não seja array lança. */
function evidenciasDoJson(v: Json | null, id: string): Evidence[] {
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error(`ai_decisions ${id}: evidences não é array`);
  return v.map((e) => evidenciaDoJson(e, id));
}

/**
 * Só as métricas NUMÉRICAS (número ou NULL explícito): é o que o card e o particionamento leem.
 * O agente também grava flags (`is_cold_start`, booleano) — ficam de fora, não viram número.
 */
function metricasDoJson(v: Json | null, id: string): Record<string, number | null> {
  if (v === null) return {};
  if (!ehObjeto(v)) throw new Error(`ai_decisions ${id}: customer_metrics não é objeto`);
  const metricas: Record<string, number | null> = {};
  for (const [chave, valor] of Object.entries(v)) {
    if (typeof valor === 'number' || valor === null) metricas[chave] = valor;
  }
  return metricas;
}

export function decisaoDaLinha(linha: Tables<'ai_decisions'>): AIDecision {
  return {
    ...linha,
    evidences: evidenciasDoJson(linha.evidences, linha.id),
    customer_metrics: metricasDoJson(linha.customer_metrics, linha.id),
  };
}
