// src/lib/access/access-matrix.ts
import type { AccessPersona, SectionId } from './types';

const ALL: SectionId[] = [
  'principal', 'clientes', 'vendas', 'operacao', 'reposicao', 'performance',
  'inteligencia', 'financeiro', 'tintometrico_cockpit', 'gestao_admin', 'docs',
];

export const ACCESS: Record<AccessPersona, { sections: SectionId[]; readOnly: SectionId[] }> = {
  gestao:           { sections: ALL, readOnly: [] },
  gestor_comercial: { sections: ['principal', 'clientes', 'vendas', 'performance', 'inteligencia', 'docs'], readOnly: [] },
  vendedor:         { sections: ['principal', 'clientes', 'vendas', 'performance', 'docs'], readOnly: [] },
  operacao:         { sections: ['principal', 'operacao', 'docs'], readOnly: [] },
  financeiro:       { sections: ['principal', 'clientes', 'vendas', 'financeiro', 'docs'], readOnly: ['vendas'] },
  // Customer renderiza o MESMO AppShell (rotas /orders /tools /profile vivem nele).
  // Mantém Dashboard + Ferramentas/tools (principal) + docs; esconde tudo de staff
  // (vendas/clientes-admin/financeiro/etc.) — mais correto que o menu permissivo antigo.
  cliente:          { sections: ['principal', 'docs'], readOnly: [] },
};

export function canAccess(persona: AccessPersona, section: SectionId): boolean {
  return ACCESS[persona].sections.includes(section);
}

export function isReadOnly(persona: AccessPersona, section: SectionId): boolean {
  return ACCESS[persona].readOnly.includes(section);
}
