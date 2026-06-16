import { describe, it, expect } from 'vitest';
import { accountToEmpresa, normalizeDoc, buildNaoVinculadoRow, classifyClienteForSnapshot } from '../snapshot';

describe('accountToEmpresa', () => {
  it('mapeia as 3 contas Omie pras empresas', () => {
    expect(accountToEmpresa('vendas')).toBe('oben');
    expect(accountToEmpresa('colacor_vendas')).toBe('colacor');
    expect(accountToEmpresa('servicos')).toBe('colacor_sc');
  });
});

describe('normalizeDoc', () => {
  it('remove tudo que não é dígito', () => {
    expect(normalizeDoc('12.345.678/0001-99')).toBe('12345678000199');
    expect(normalizeDoc('123.456.789-00')).toBe('12345678900');
  });
  it('trata null/undefined/vazio como string vazia', () => {
    expect(normalizeDoc(undefined)).toBe('');
    expect(normalizeDoc(null)).toBe('');
    expect(normalizeDoc('')).toBe('');
  });
});

describe('buildNaoVinculadoRow', () => {
  const ts = '2026-05-27T10:00:00.000Z';

  it('monta a linha normalizando doc e aplicando fallbacks null', () => {
    const row = buildNaoVinculadoRow(
      {
        codigo_cliente_omie: 4242,
        codigo_vendedor: 7,
        cnpj_cpf: '12.345.678/0001-99',
        razao_social: '  Marcenaria Silva LTDA  ',
        nome_fantasia: 'Móveis Silva',
        cidade: 'Curitiba',
        estado: 'PR',
      },
      'oben',
      ts,
    );
    expect(row).toEqual({
      empresa: 'oben',
      omie_codigo_cliente: 4242,
      cnpj_cpf: '12345678000199',
      razao_social: 'Marcenaria Silva LTDA',
      nome_fantasia: 'Móveis Silva',
      cidade: 'Curitiba',
      uf: 'PR',
      codigo_vendedor: 7,
      synced_at: ts,
    });
  });

  it('campos ausentes/vazios viram null (menos empresa/codigo/synced_at)', () => {
    const row = buildNaoVinculadoRow(
      { codigo_cliente_omie: 1, cnpj_cpf: '' },
      'colacor',
      ts,
    );
    expect(row.razao_social).toBeNull();
    expect(row.nome_fantasia).toBeNull();
    expect(row.cidade).toBeNull();
    expect(row.uf).toBeNull();
    expect(row.codigo_vendedor).toBeNull();
    expect(row.cnpj_cpf).toBe('');
    expect(row.empresa).toBe('colacor');
    expect(row.omie_codigo_cliente).toBe(1);
    expect(row.synced_at).toBe(ts);
  });
});

describe('classifyClienteForSnapshot', () => {
  const codigos = new Set<number>([10, 20]);
  const docs = new Set<string>(['12345678000199']);

  it('linked quando o código está em omie_clientes (mesmo sem profile)', () => {
    expect(classifyClienteForSnapshot({ codigo_cliente_omie: 10, cnpj_cpf: '99999999999' }, codigos, docs)).toBe('linked');
  });

  it('has_profile quando o doc tem profile mas o código não está vinculado (NÃO é não-vinculado)', () => {
    // cenário do bug do design antigo: tem profile mas ainda sem linha em omie_clientes
    expect(classifyClienteForSnapshot({ codigo_cliente_omie: 777, cnpj_cpf: '12.345.678/0001-99' }, codigos, docs)).toBe('has_profile');
  });

  it('unlinked quando não tem vínculo E não tem profile', () => {
    expect(classifyClienteForSnapshot({ codigo_cliente_omie: 777, cnpj_cpf: '55.555.555/5555-55' }, codigos, docs)).toBe('unlinked');
  });

  it('skip quando falta doc ou código Omie', () => {
    expect(classifyClienteForSnapshot({ codigo_cliente_omie: 777, cnpj_cpf: '' }, codigos, docs)).toBe('skip');
    expect(classifyClienteForSnapshot({ cnpj_cpf: '55555555555555' }, codigos, docs)).toBe('skip');
  });

  it('código vem como string do Omie ainda casa o set numérico', () => {
    const c = { codigo_cliente_omie: '20' as unknown as number, cnpj_cpf: '55555555555555' };
    expect(classifyClienteForSnapshot(c, codigos, docs)).toBe('linked');
  });
});
