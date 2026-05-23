// src/lib/access/resolve-access.ts
import type { AppRole } from '@/contexts/AuthContext';
import type { CommercialRole } from '@/hooks/useCommercialRole';
import type { Department } from '@/integrations/supabase/types-departments';
import type { AccessPersona, GroupTag } from './types';

export interface AccessSignals {
  appRole: AppRole | null;
  commercialRole: CommercialRole | null;
  department: Department | null;
  isSalesOnly: boolean;
}

/** Resolve a persona de acesso de forma DETERMINÍSTICA (sem heurística). */
export function resolveAccessPersona(s: AccessSignals): AccessPersona {
  if (s.appRole === 'master'
    || s.commercialRole === 'estrategico'
    || s.commercialRole === 'super_admin'
    || s.commercialRole === 'master') return 'gestao';
  if (s.commercialRole === 'gerencial' || s.department === 'gestao') return 'gestor_comercial';
  if (s.department === 'financeiro') return 'financeiro';
  if (s.department === 'separador' || s.department === 'conferente' || s.department === 'tintometrico') return 'operacao';
  if (s.appRole === 'customer') return 'cliente';
  // operacional/farmer/hunter/closer, dept vendas, sales-only, ou staff sem tag → vendedor (default)
  return 'vendedor';
}

/** Tag de grupo comercial (não muda acesso; usada pela Performance e pela home). */
export function resolveGroupTag(commercialRole: CommercialRole | null): GroupTag | null {
  if (commercialRole === 'hunter' || commercialRole === 'farmer' || commercialRole === 'closer') {
    return commercialRole;
  }
  return null;
}
