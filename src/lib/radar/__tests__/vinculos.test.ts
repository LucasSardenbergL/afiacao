import { describe, it, expect } from 'vitest';
import { evidenciaVinculo, lerVinculo, rotuloForca, tituloVinculo, type VinculoCliente } from '../vinculos';

const base = { cliente_cnpj: '21111111000101', cliente_nome: 'ANTIGA LTDA', cliente_situacao: '02', forca: 'forte', sinais: ['pessoa'] };
const v = (o: Partial<VinculoCliente>): VinculoCliente => ({ ...lerVinculo(base), ...o });

describe('lerVinculo', () => {
  it('lê a linha da RPC', () => {
    expect(lerVinculo(base)).toEqual({
      clienteCnpj: '21111111000101', clienteNome: 'ANTIGA LTDA', clienteSituacao: '02', forca: 'forte', sinais: ['pessoa'],
    });
  });

  it.each([
    ['sem cnpj', { ...base, cliente_cnpj: null }],
    ['força desconhecida', { ...base, forca: 'veredito' }],
    ['sinal desconhecido (parentesco nunca é sinal)', { ...base, sinais: ['parente'] }],
    ['sem sinais', { ...base, sinais: [] }],
    ['sinais não-lista', { ...base, sinais: 'pessoa' }],
    ['linha nula', null],
  ])('LANÇA na forma inesperada: %s', (_, linha) => {
    expect(() => lerVinculo(linha)).toThrow('radar_possiveis_vinculos: resposta fora da forma esperada');
  });
});

describe('textos do selo', () => {
  it('cliente baixado/inapto na Receita → "possível sucessor"', () => {
    expect(tituloVinculo(v({ clienteSituacao: '08' }))).toBe('Possível sucessor de ANTIGA LTDA (baixada na Receita)');
    expect(tituloVinculo(v({ clienteSituacao: '04' }))).toBe('Possível sucessor de ANTIGA LTDA (inapta na Receita)');
  });

  it('cliente ativo ou situação desconhecida → "possível vínculo"', () => {
    expect(tituloVinculo(v({ clienteSituacao: '02' }))).toBe('Possível vínculo com ANTIGA LTDA');
    expect(tituloVinculo(v({ clienteSituacao: null }))).toBe('Possível vínculo com ANTIGA LTDA');
  });

  it('sem nome não inventa um', () => {
    expect(tituloVinculo(v({ clienteNome: null }))).toBe('Possível vínculo com um cliente da base');
  });

  it('a evidência nomeia cada sinal e nunca fala em parentesco', () => {
    const t = evidenciaVinculo(v({ sinais: ['endereco', 'pessoa', 'telefone', 'email'] }));
    expect(t).toBe('mesmo endereço completo · mesmo sócio ou titular, no mesmo município · mesmo telefone · mesmo e-mail');
    expect(t).not.toMatch(/parente|c[oô]njuge|filho/);
  });

  it('força é rotulada como pista', () => {
    expect(rotuloForca('forte')).toBe('pista forte');
    expect(rotuloForca('media')).toBe('pista média');
  });
});
