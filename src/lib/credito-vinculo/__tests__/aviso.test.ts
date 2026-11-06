import { describe, it, expect } from 'vitest';
import { cnpjDoDocumento, exibicaoDoAviso, lerAvisoVinculo, nomeVinculado, textoNaoVerificado } from '../aviso';

/**
 * Aviso de vínculo com devedor — borda pura. Money-path: forma errada LANÇA (nunca "sem pendência"), nenhum estado
 * afirma "em dia", e 'fora_da_base'/indeterminado viram "não verificado" (decisão do founder, 2026-11-06).
 */
const credora = (over: Record<string, unknown> = {}) => ({
  company: 'oben', vencido: 500, n_titulos: 1, dias_vencido_max: 30, vencimento_mais_antigo: '2026-10-07',
  sync_em: '2026-11-06T14:28:11Z', qualidade: 'ok', n_ambiguos: 0, n_invalidos: 0, ...over,
});
const vinculo = (over: Record<string, unknown> = {}) => ({
  ref: 1, cliente_cnpj: '21111111000101', cliente_nome: 'C1 ANTIGA LTDA', cliente_situacao: '08',
  forca: 'forte', sinais: ['email', 'telefone'], parcial: false, credoras: [credora()], ...over,
});
const avaliado = (over: Record<string, unknown> = {}) => ({
  estado: 'avaliado', regra_versao: 1, n_vinculos: 1, n_indeterminados: 0, vinculos: [vinculo()], ...over,
});

describe('lerAvisoVinculo', () => {
  it('lê o aviso avaliado com credora', () => {
    const a = lerAvisoVinculo(avaliado());
    expect(a.estado).toBe('avaliado');
    if (a.estado !== 'avaliado') throw new Error('tipo');
    expect(a.vinculos[0]).toMatchObject({ ref: 1, forca: 'forte', parcial: false });
    expect(a.vinculos[0].credoras[0]).toMatchObject({ company: 'oben', vencido: 500, nTitulos: 1, qualidade: 'ok' });
  });

  it('fora_da_base é estado próprio', () => {
    expect(lerAvisoVinculo({ estado: 'fora_da_base', regra_versao: 1 })).toEqual({ estado: 'fora_da_base' });
  });

  it('cliente oculto (sem carteira) chega sem nome e sem CNPJ', () => {
    const a = lerAvisoVinculo(avaliado({ vinculos: [vinculo({ cliente_cnpj: null, cliente_nome: null })] }));
    if (a.estado !== 'avaliado') throw new Error('tipo');
    expect(nomeVinculado(a.vinculos[0])).toBe('um cliente da carteira — confira com a gestão');
  });

  it.each([
    ['nulo', null],
    ['estado desconhecido', { estado: 'ok' }],
    ['sem vinculos', { estado: 'avaliado', n_vinculos: 0, n_indeterminados: 0 }],
    ['credora com vencido 0 (nunca zero fabricado)', avaliado({ vinculos: [vinculo({ credoras: [credora({ vencido: 0 })] })] })],
    ['credora com vencido nulo', avaliado({ vinculos: [vinculo({ credoras: [credora({ vencido: null })] })] })],
    ['vínculo sem credora', avaliado({ vinculos: [vinculo({ credoras: [] })] })],
    ['conta fora do vocabulário', avaliado({ vinculos: [vinculo({ credoras: [credora({ company: 'afiacao' })] })] })],
    ['força desconhecida', avaliado({ vinculos: [vinculo({ forca: 'fraca' })] })],
    ['sinal desconhecido', avaliado({ vinculos: [vinculo({ sinais: ['parente'] })] })],
    ['parcial ausente', avaliado({ vinculos: [vinculo({ parcial: undefined })] })],
    ['contagens incoerentes', avaliado({ n_vinculos: 0 })],
    ['n_indeterminados negativo', avaliado({ n_indeterminados: -1 })],
  ])('forma errada LANÇA: %s', (_n, j) => {
    expect(() => lerAvisoVinculo(j)).toThrow('credito_vinculo_aviso: resposta fora da forma esperada');
  });
});

describe('cnpjDoDocumento', () => {
  it('CNPJ com máscara, cru e alfanumérico', () => {
    expect(cnpjDoDocumento('21.111.111/0001-01')).toBe('21111111000101');
    expect(cnpjDoDocumento('ab12cd34000195')).toBe('AB12CD34000195');
  });
  it('CPF, vazio e lixo → null (o aviso não avalia CPF)', () => {
    expect(cnpjDoDocumento('123.456.789-09')).toBeNull();
    expect(cnpjDoDocumento('')).toBeNull();
    expect(cnpjDoDocumento(null)).toBeNull();
    expect(cnpjDoDocumento('1234567890123A')).toBeNull();
  });
});

describe('exibicaoDoAviso — nunca há "sem pendência"', () => {
  const base = { cnpj: '11111111000101', carregando: false, falhou: false };
  it('CPF → não verificado (cpf), mesmo sem leitura', () => {
    expect(exibicaoDoAviso({ ...base, cnpj: null, aviso: null })).toEqual({ tipo: 'nao_verificado', motivo: 'cpf' });
  });
  it('falha (inclusive com dado anterior) → não consegui', () => {
    expect(exibicaoDoAviso({ ...base, falhou: true, aviso: lerAvisoVinculo(avaliado()) })).toEqual({ tipo: 'nao_consegui' });
  });
  it('carregando → nada (não é verificação concluída nem aviso)', () => {
    expect(exibicaoDoAviso({ ...base, carregando: true, aviso: null })).toEqual({ tipo: 'nada' });
  });
  it('fora da base → não verificado', () => {
    expect(exibicaoDoAviso({ ...base, aviso: { estado: 'fora_da_base' } })).toEqual({ tipo: 'nao_verificado', motivo: 'fora_da_base' });
  });
  it('sem aviso mas com indeterminado → não verificado com a contagem', () => {
    const a = lerAvisoVinculo(avaliado({ n_vinculos: 2, n_indeterminados: 2, vinculos: [] }));
    expect(exibicaoDoAviso({ ...base, aviso: a })).toEqual({ tipo: 'nao_verificado', motivo: 'indeterminado', n: 2 });
  });
  it('avaliação completa sem evidência → nada', () => {
    const a = lerAvisoVinculo(avaliado({ n_vinculos: 1, n_indeterminados: 0, vinculos: [] }));
    expect(exibicaoDoAviso({ ...base, aviso: a })).toEqual({ tipo: 'nada' });
  });
  it('evidência positiva → aviso (com os indeterminados ao lado)', () => {
    const a = lerAvisoVinculo(avaliado({ n_vinculos: 3, n_indeterminados: 2 }));
    const e = exibicaoDoAviso({ ...base, aviso: a });
    expect(e.tipo).toBe('aviso');
    if (e.tipo === 'aviso') expect(e.nIndeterminados).toBe(2);
  });
});

describe('textos', () => {
  it('sucessor baixado e não verificado', () => {
    expect(nomeVinculado({ clienteNome: 'C1 LTDA', clienteCnpj: '21111111000101', clienteSituacao: '08' })).toBe('C1 LTDA (baixada na Receita)');
    expect(textoNaoVerificado('fora_da_base')).toBe('Vínculo com devedor não verificado (CNPJ fora da base da Receita).');
    expect(textoNaoVerificado('indeterminado', 1)).toContain('1 possível vínculo sem código Omie com prova');
    expect(textoNaoVerificado('indeterminado', 2)).toContain('2 possíveis vínculos');
  });
});
