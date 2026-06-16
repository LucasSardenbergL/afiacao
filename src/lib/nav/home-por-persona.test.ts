import { describe, expect, it } from 'vitest';
import { resolverHomeStaff, itemVisivelParaSalesOnly } from './home-por-persona';

describe('resolverHomeStaff', () => {
  it.each(['farmer', 'hunter', 'closer', 'operacional'])(
    'cargo %s (vendedora) → /meu-dia',
    (cargo) => {
      expect(resolverHomeStaff({ commercialRole: cargo, isSalesOnly: false })).toBe('/meu-dia');
    },
  );

  it.each(['gerencial', 'estrategico', 'super_admin', 'master'])(
    'cargo %s (gestão) mantém o cockpit',
    (cargo) => {
      expect(resolverHomeStaff({ commercialRole: cargo, isSalesOnly: false })).toBeNull();
    },
  );

  it('sales-only sem cargo comercial → /meu-dia', () => {
    expect(resolverHomeStaff({ commercialRole: null, isSalesOnly: true })).toBe('/meu-dia');
  });

  it('sales-only domina mesmo com cargo de gestão (o menu dela já é só-Vendas)', () => {
    expect(resolverHomeStaff({ commercialRole: 'gerencial', isSalesOnly: true })).toBe('/meu-dia');
  });

  it('staff sem cargo e sem sales-only mantém o cockpit', () => {
    expect(resolverHomeStaff({ commercialRole: null, isSalesOnly: false })).toBeNull();
  });

  it('cargo desconhecido não redireciona (conservador)', () => {
    expect(resolverHomeStaff({ commercialRole: 'estagiario', isSalesOnly: false })).toBeNull();
  });
});

describe('itemVisivelParaSalesOnly', () => {
  it('toda a seção Vendas é visível', () => {
    expect(itemVisivelParaSalesOnly('Vendas', '/sales')).toBe(true);
    expect(itemVisivelParaSalesOnly('Vendas', '/rota/ligacoes')).toBe(true);
  });

  it('Meu dia e Clientes (seção Principal) entram pela allowlist', () => {
    expect(itemVisivelParaSalesOnly('Principal', '/meu-dia')).toBe(true);
    expect(itemVisivelParaSalesOnly('Principal', '/admin/customers')).toBe(true);
  });

  it('Dashboard (/) continua escondido pra sales-only', () => {
    expect(itemVisivelParaSalesOnly('Principal', '/')).toBe(false);
  });

  it.each([
    ['Reposição', '/admin/reposicao/sessao'],
    ['Financeiro', '/financeiro/cockpit'],
    ['Estoque', '/admin/estoque/picking'],
    ['Documentação', '/docs'],
  ])('seção %s segue invisível pra sales-only', (secao, path) => {
    expect(itemVisivelParaSalesOnly(secao, path)).toBe(false);
  });
});
