import type { Persona } from './persona-config';
import type { RouteCounts } from './route-tracker';
import type { CommercialRole } from '@/hooks/useCommercialRole';
import type { AppRole } from '@/contexts/AuthContext';
import type { Department } from '@/integrations/supabase/types-departments';

export type PersonaSource = 'manual' | 'commercial_role' | 'sales_only' | 'inference' | 'default' | 'department';

export interface PersonaSignals {
  override: Persona | null;
  role: AppRole | null;
  commercialRole: CommercialRole | null;
  isSalesOnly: boolean;
  routeCounts: RouteCounts;
  userDepartment: Department | null;
}

export interface InferPersonaResult {
  persona: Persona;
  source: PersonaSource;
}

const HEURISTIC_MIN_VISITS = 10;
const HEURISTIC_MIN_RATIO = 0.4;

const PREFIX_TO_PERSONA: Record<string, Persona> = {
  '/admin/reposicao': 'comprador',
  '/admin/estoque':   'estoque',
  '/recebimento':     'estoque',
  '/financeiro':      'financeiro',
  '/tintometrico':    'tintometrico',
  '/sales':           'vendedor',
};

const DEPARTMENT_TO_PERSONA: Record<Department, Persona> = {
  vendas: 'vendedor',
  gestao: 'gestor',
  comprador: 'comprador',
  separador: 'estoque',
  conferente: 'estoque',
  tintometrico: 'tintometrico',
  financeiro: 'financeiro',
  outro: 'geral',
};

export function inferPersona(signals: PersonaSignals): InferPersonaResult {
  // 1. Override manual sempre vence
  if (signals.override) {
    return { persona: signals.override, source: 'manual' };
  }

  // 2. user_departments.primary_dept (persistência server > inferência)
  if (signals.userDepartment) {
    const persona = DEPARTMENT_TO_PERSONA[signals.userDepartment];
    return { persona, source: 'department' };
  }

  // 3. Sales-only CPF → vendedor (mais específico que commercial_role)
  if (signals.isSalesOnly) {
    return { persona: 'vendedor', source: 'sales_only' };
  }

  // 4. commercial_role
  switch (signals.commercialRole) {
    case 'operacional': return { persona: 'vendedor', source: 'commercial_role' };
    case 'gerencial':   return { persona: 'gestor', source: 'commercial_role' };
    case 'estrategico': return { persona: 'master', source: 'commercial_role' };
    case 'super_admin': return { persona: 'master', source: 'commercial_role' };
  }

  // 5. Heurística por prefixo de uso
  const total = Object.values(signals.routeCounts).reduce((sum, e) => sum + e.count, 0);
  if (total >= HEURISTIC_MIN_VISITS) {
    // Agregar contagens por persona (estoque/recebimento contam pra mesma persona)
    const byPersona: Record<string, number> = {};
    for (const [prefix, entry] of Object.entries(signals.routeCounts)) {
      const persona = PREFIX_TO_PERSONA[prefix];
      if (!persona) continue;
      byPersona[persona] = (byPersona[persona] ?? 0) + entry.count;
    }

    let topPersona: Persona | null = null;
    let topCount = 0;
    for (const [persona, count] of Object.entries(byPersona)) {
      if (count > topCount) {
        topPersona = persona as Persona;
        topCount = count;
      }
    }

    if (topPersona && topCount / total >= HEURISTIC_MIN_RATIO) {
      return { persona: topPersona, source: 'inference' };
    }
  }

  // 6. Default
  if (signals.role === 'master') return { persona: 'master', source: 'default' };
  return { persona: 'geral', source: 'default' };
}
