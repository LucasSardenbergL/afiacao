import { describe, it, expect } from 'vitest';
import {
  normalizarDocumento,
  montarTelefone,
  decidirLinhaProfile,
} from '@/lib/clientes-cadastro/backfill-helpers';

describe('normalizarDocumento', () => {
  it('aceita CPF DV-válido (11 dígitos) e remove máscara', () => {
    expect(normalizarDocumento('123.456.789-09')).toBe('12345678909');
    expect(normalizarDocumento('111.444.777-35')).toBe('11144477735');
  });
  it('aceita CNPJ DV-válido (14 dígitos) e remove máscara', () => {
    expect(normalizarDocumento('12.345.678/0001-95')).toBe('12345678000195');
    expect(normalizarDocumento('11.222.333/0001-81')).toBe('11222333000181');
  });
  it('rejeita CPF com dígito verificador inválido → null', () => {
    expect(normalizarDocumento('123.456.789-00')).toBeNull(); // DV errado
    expect(normalizarDocumento('12345678901')).toBeNull();
  });
  it('rejeita CNPJ com dígito verificador inválido → null', () => {
    expect(normalizarDocumento('12.345.678/0001-99')).toBeNull(); // DV errado
    expect(normalizarDocumento('11222333000180')).toBeNull();
  });
  it('rejeita comprimento inválido → null', () => {
    expect(normalizarDocumento('123')).toBeNull();
    expect(normalizarDocumento('123456789012')).toBeNull(); // 12 dígitos
  });
  it('rejeita todos os dígitos iguais (sentinela) → null', () => {
    expect(normalizarDocumento('00000000000')).toBeNull();
    expect(normalizarDocumento('11111111111111')).toBeNull();
  });
  it('vazio / null / undefined / só letras → null', () => {
    expect(normalizarDocumento('')).toBeNull();
    expect(normalizarDocumento(null)).toBeNull();
    expect(normalizarDocumento(undefined)).toBeNull();
    expect(normalizarDocumento('ABC')).toBeNull();
  });
});

describe('montarTelefone', () => {
  it('junta ddd + numero (só dígitos)', () => {
    expect(montarTelefone('(31)', '3333-4444')).toBe('3133334444');
  });
  it('só número, sem ddd', () => {
    expect(montarTelefone(null, '33334444')).toBe('33334444');
  });
  it('vazio / curto demais → null', () => {
    expect(montarTelefone('', '')).toBeNull();
    expect(montarTelefone(null, '123')).toBeNull();
  });
});

const baseArgs = () => ({
  userId: 'u1',
  authCreatedAt: '2026-03-01T00:00:00Z',
  cadastro: {
    razao_social: 'INDUSTRIA MOVELEIRA LTDA',
    nome_fantasia: 'MoveBem',
    cnpj_cpf: '12.345.678/0001-95',
    telefone_ddd: '31',
    telefone_numero: '3333-4444',
  },
  masterCnpj: '11222333000181', // CNPJ DV-válido ≠ documento-base
  docsExistentes: new Set<string>(),
  docsNoLote: new Set<string>(),
});

describe('decidirLinhaProfile — inserção', () => {
  it('monta a linha com nome_fantasia preferido e created_at preservado (NÃO now())', () => {
    const d = decidirLinhaProfile(baseArgs());
    expect(d.acao).toBe('inserir');
    if (d.acao !== 'inserir') return;
    expect(d.row).toMatchObject({
      user_id: 'u1',
      name: 'MoveBem',
      phone: '3133334444',
      document: '12345678000195',
      customer_type: null,
      prospect_source: 'omie_import',
      is_employee: false,
      is_approved: false,
      created_at: '2026-03-01T00:00:00Z', // não a data do backfill
    });
  });

  it('cai pra razao_social quando não há nome_fantasia', () => {
    const a = baseArgs();
    a.cadastro.nome_fantasia = null as unknown as string;
    const d = decidirLinhaProfile(a);
    expect(d.acao === 'inserir' && d.row.name).toBe('INDUSTRIA MOVELEIRA LTDA');
  });

  it("usa 'Cliente' quando não há nome nenhum", () => {
    const a = baseArgs();
    a.cadastro.nome_fantasia = null as unknown as string;
    a.cadastro.razao_social = '   ' as unknown as string;
    const d = decidirLinhaProfile(a);
    expect(d.acao === 'inserir' && d.row.name).toBe('Cliente');
  });

  it('documento inválido → insere com document NULL (não pula)', () => {
    const a = baseArgs();
    a.cadastro.cnpj_cpf = '000' as unknown as string;
    const d = decidirLinhaProfile(a);
    expect(d.acao).toBe('inserir');
    expect(d.acao === 'inserir' && d.row.document).toBeNull();
  });
});

describe('decidirLinhaProfile — bloqueios de segurança e dedup', () => {
  it('documento == master_cnpj → pula (trigger promoveria a master); compara normalizado', () => {
    const a = baseArgs();
    a.cadastro.cnpj_cpf = '11.222.333/0001-81'; // == masterCnpj com máscara
    const d = decidirLinhaProfile(a);
    expect(d).toEqual({ acao: 'pular', motivo: 'master_cnpj' });
  });

  it('documento já existe em outro profile → pula', () => {
    const a = baseArgs();
    a.docsExistentes = new Set(['12345678000195']);
    const d = decidirLinhaProfile(a);
    expect(d).toEqual({ acao: 'pular', motivo: 'doc_em_outro_profile' });
  });

  it('documento duplicado dentro do próprio lote → pula', () => {
    const a = baseArgs();
    a.docsNoLote = new Set(['12345678000195']);
    const d = decidirLinhaProfile(a);
    expect(d).toEqual({ acao: 'pular', motivo: 'doc_duplicado_no_lote' });
  });

  it('master_cnpj só bloqueia com documento; doc inválido NÃO vira master por coincidência vazia', () => {
    const a = baseArgs();
    a.cadastro.cnpj_cpf = 'XYZ' as unknown as string; // normaliza p/ null
    a.masterCnpj = '' as unknown as string;            // master vazio
    const d = decidirLinhaProfile(a);
    expect(d.acao).toBe('inserir'); // null != '' → não bloqueia; document NULL
    expect(d.acao === 'inserir' && d.row.document).toBeNull();
  });

  it('dedup tem precedência sobre inserção, mas master_cnpj tem precedência sobre dedup', () => {
    const a = baseArgs();
    a.cadastro.cnpj_cpf = '11222333000181';     // == master
    a.docsExistentes = new Set(['11222333000181']); // e também já existe
    const d = decidirLinhaProfile(a);
    expect(d).toEqual({ acao: 'pular', motivo: 'master_cnpj' }); // master ganha
  });
});
