import { describe, it, expect } from 'vitest';
import { getHelpMappingForRoute, hasHelpForRoute } from '../help-utils';

describe('getHelpMappingForRoute', () => {
  it('retorna null em rota sem ajuda mapeada (antes caía no fallback genérico → painel "nada encontrado")', () => {
    expect(getHelpMappingForRoute('/meu-dia')).toBeNull();
    expect(getHelpMappingForRoute('/financeiro/cockpit')).toBeNull();
    expect(getHelpMappingForRoute('/sales')).toBeNull();
    expect(getHelpMappingForRoute('/')).toBeNull();
  });

  it('casa a regra ESPECÍFICA antes da genérica do mesmo módulo (prioridade por ordem)', () => {
    expect(getHelpMappingForRoute('/admin/des/trimestre-atual')).toEqual({
      module: 'avaliacao-trimestral-des',
      anchor: 'posicao-ao-vivo',
    });
    expect(getHelpMappingForRoute('/admin/des/configuracao')).toEqual({
      module: 'avaliacao-trimestral-des',
      anchor: 'visao-geral-do-programa-des',
    });
    // /admin/des sem sufixo cai na regra genérica do próprio módulo
    expect(getHelpMappingForRoute('/admin/des')).toEqual({
      module: 'avaliacao-trimestral-des',
      anchor: 'visao-geral-do-programa-des',
    });
  });

  it('mapeia reposição: a regra específica vence o prefixo /admin/reposicao', () => {
    expect(getHelpMappingForRoute('/admin/reposicao/negociacao-paralela')).toEqual({
      module: 'negociacao-paralela',
      anchor: 'ranking-de-candidatos',
    });
    expect(getHelpMappingForRoute('/admin/reposicao/pedidos')).toEqual({
      module: 'eventos-comerciais',
      anchor: 'ciclo-de-oportunidade',
    });
    expect(getHelpMappingForRoute('/admin/reposicao')).toEqual({
      module: 'eventos-comerciais',
      anchor: 'visão-geral',
    });
  });
});

describe('hasHelpForRoute', () => {
  it('false em rota sem ajuda → o HelpDrawer esconde o botão "?"', () => {
    expect(hasHelpForRoute('/meu-dia')).toBe(false);
    expect(hasHelpForRoute('/sales')).toBe(false);
    expect(hasHelpForRoute('/tools')).toBe(false);
  });

  it('true em rota com ajuda mapeada', () => {
    expect(hasHelpForRoute('/admin/reposicao/negociacao-paralela')).toBe(true);
    expect(hasHelpForRoute('/admin/des/configuracao')).toBe(true);
    expect(hasHelpForRoute('/admin/reposicao/promocoes')).toBe(true);
  });
});
