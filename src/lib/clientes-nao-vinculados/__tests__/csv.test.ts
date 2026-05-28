import { describe, it, expect } from 'vitest';
import { toCsv } from '../csv';

describe('toCsv', () => {
  it('começa com a linha de cabeçalho', () => {
    expect(toCsv([]).split('\r\n')[0]).toBe('codigo_omie;cnpj_cpf;razao_social;nome_fantasia;cidade;uf;codigo_vendedor');
  });

  it('monta uma linha com os campos na ordem certa', () => {
    const csv = toCsv([
      { omie_codigo_cliente: 42, cnpj_cpf: '12345678000199', razao_social: 'Marcenaria Silva', nome_fantasia: 'Móveis Silva', cidade: 'Curitiba', uf: 'PR', codigo_vendedor: 7 },
    ]);
    expect(csv.split('\r\n')[1]).toBe('42;12345678000199;Marcenaria Silva;Móveis Silva;Curitiba;PR;7');
  });

  it('null/undefined viram célula vazia', () => {
    const csv = toCsv([
      { omie_codigo_cliente: 1, cnpj_cpf: null, razao_social: null, nome_fantasia: null, cidade: null, uf: null, codigo_vendedor: null },
    ]);
    expect(csv.split('\r\n')[1]).toBe('1;;;;;;');
  });

  it('escapa campo com delimitador, aspas e quebra de linha (RFC4180)', () => {
    const csv = toCsv([
      { omie_codigo_cliente: 9, cnpj_cpf: null, razao_social: 'Silva; Souza "ME"\nLtda', nome_fantasia: null, cidade: null, uf: null, codigo_vendedor: null },
    ]);
    // o campo problemático fica entre aspas, com aspas internas dobradas
    expect(csv.split('\r\n')[0]).toBe('codigo_omie;cnpj_cpf;razao_social;nome_fantasia;cidade;uf;codigo_vendedor');
    expect(csv).toContain('9;;"Silva; Souza ""ME""\nLtda";;;;');
  });

  it('separa linhas com CRLF (Excel)', () => {
    const csv = toCsv([
      { omie_codigo_cliente: 1, cnpj_cpf: null, razao_social: 'A', nome_fantasia: null, cidade: null, uf: null, codigo_vendedor: null },
      { omie_codigo_cliente: 2, cnpj_cpf: null, razao_social: 'B', nome_fantasia: null, cidade: null, uf: null, codigo_vendedor: null },
    ]);
    expect(csv.split('\r\n')).toHaveLength(3); // header + 2 linhas
  });
});
