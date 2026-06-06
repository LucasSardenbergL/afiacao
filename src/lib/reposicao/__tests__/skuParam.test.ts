import { describe, it, expect } from 'vitest';
import {
  fonteBadgeVariant,
  fonteBadgeLabel,
  classBadge,
  fmt,
  fmtBRL,
  isDescontinuado,
  reativarPayload,
} from '../sku-param';

describe('fonteBadgeVariant', () => {
  it('null/undefined/vazio → danger', () => {
    expect(fonteBadgeVariant(null)).toBe('danger');
    expect(fonteBadgeVariant(undefined)).toBe('danger');
    expect(fonteBadgeVariant('')).toBe('danger');
  });

  it('compra + real → success (case-insensitive)', () => {
    expect(fonteBadgeVariant('compra real')).toBe('success');
    expect(fonteBadgeVariant('Compra Real')).toBe('success');
    expect(fonteBadgeVariant('preço de compra (real)')).toBe('success');
  });

  it('compra sem real cai pra estim → warning', () => {
    // tem 'compra' mas não 'real'; tem 'estim' → warning (ordem dos ifs)
    expect(fonteBadgeVariant('compra estimada')).toBe('warning');
  });

  it('estim → warning', () => {
    expect(fonteBadgeVariant('estimado')).toBe('warning');
    expect(fonteBadgeVariant('ESTIMATIVA')).toBe('warning');
  });

  it('sem → danger', () => {
    expect(fonteBadgeVariant('sem preço')).toBe('danger');
  });

  it('desconhecido → outline', () => {
    expect(fonteBadgeVariant('qualquer coisa')).toBe('outline');
  });
});

describe('fonteBadgeLabel', () => {
  it('null/vazio → Sem preço', () => {
    expect(fonteBadgeLabel(null)).toBe('Sem preço');
    expect(fonteBadgeLabel(undefined)).toBe('Sem preço');
    expect(fonteBadgeLabel('')).toBe('Sem preço');
  });

  it('compra + real → Compra real', () => {
    expect(fonteBadgeLabel('compra real')).toBe('Compra real');
    expect(fonteBadgeLabel('Compra Real')).toBe('Compra real');
  });

  it('estim → Estimado', () => {
    expect(fonteBadgeLabel('estimado')).toBe('Estimado');
  });

  it('sem → Sem preço', () => {
    expect(fonteBadgeLabel('sem dados')).toBe('Sem preço');
  });

  it('fallback devolve o fonte original (NÃO lowercased)', () => {
    expect(fonteBadgeLabel('XPTO')).toBe('XPTO');
    expect(fonteBadgeLabel('Tabela Manual')).toBe('Tabela Manual');
  });
});

describe('classBadge', () => {
  it('null → secondary', () => {
    expect(classBadge(null)).toBe('secondary');
  });

  it('classe A → destructive (olha só o 1º char)', () => {
    expect(classBadge('A')).toBe('destructive');
    expect(classBadge('AX')).toBe('destructive');
  });

  it('classe B → default', () => {
    expect(classBadge('B')).toBe('default');
    expect(classBadge('BY')).toBe('default');
  });

  it('classe C / outras → secondary', () => {
    expect(classBadge('C')).toBe('secondary');
    expect(classBadge('CZ')).toBe('secondary');
    expect(classBadge('X')).toBe('secondary');
  });
});

describe('fmt', () => {
  it('null/undefined → travessão', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
  });

  it('zero formata (não é tratado como vazio)', () => {
    expect(fmt(0)).toBe('0,00');
  });

  it('milhar + 2 casas por padrão (pt-BR)', () => {
    expect(fmt(1234.5)).toBe('1.234,50');
    expect(fmt(1000000)).toBe('1.000.000,00');
  });

  it('respeita o parâmetro de casas decimais', () => {
    expect(fmt(2.5, 1)).toBe('2,5');
    expect(fmt(1200, 0)).toBe('1.200');
  });
});

describe('fmtBRL', () => {
  it('null/undefined → travessão', () => {
    expect(fmtBRL(null)).toBe('—');
    expect(fmtBRL(undefined)).toBe('—');
  });

  it('zero formata como moeda (não vira travessão)', () => {
    const out = fmtBRL(0);
    expect(out).toContain('R$');
    expect(out).toContain('0,00');
  });

  it('valor em BRL pt-BR (milhar + 2 casas)', () => {
    const out = fmtBRL(1234.5);
    expect(out).toContain('R$');
    expect(out).toContain('1.234,50');
  });
});

describe('isDescontinuado', () => {
  it('true só para tipo_reposicao === "descontinuado"', () => {
    expect(isDescontinuado({ tipo_reposicao: 'descontinuado' })).toBe(true);
  });
  it('false para automatica / null / undefined / produto_acabado', () => {
    expect(isDescontinuado({ tipo_reposicao: 'automatica' })).toBe(false);
    expect(isDescontinuado({ tipo_reposicao: null })).toBe(false);
    expect(isDescontinuado({})).toBe(false);
    expect(isDescontinuado({ tipo_reposicao: 'produto_acabado' })).toBe(false);
  });
});

describe('reativarPayload', () => {
  it('religa AMBOS os campos (habilitado=true E tipo=automatica)', () => {
    // Trava contra religar só metade: deixar tipo='descontinuado' faria o motor
    // continuar barrando o SKU mesmo com habilitado=true.
    expect(reativarPayload()).toEqual({
      habilitado_reposicao_automatica: true,
      tipo_reposicao: 'automatica',
    });
  });
});
