import { describe, it, expect } from 'vitest';
import { evidenciaVinculo, lerResumoVinculo, lerVinculo, rotuloForca, seloVinculo, tituloVinculo, type ResumoVinculoLista, type VinculoCliente } from '../vinculos';

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

// ── Selo da LISTA (RPC em lote radar_vinculos_por_cnpjs) ──
const crua = { cnpj: '10101010000101', forca: 'forte', clientes: 2, clientes_nomes: ['C10B LTDA', 'C10A LTDA'], clientes_situacoes: ['02', '08'] };
const resumo = (o: Partial<ResumoVinculoLista> = {}): ResumoVinculoLista => ({ ...lerResumoVinculo(crua).resumo, ...o });

describe('lerResumoVinculo', () => {
  it('lê a linha da RPC em lote', () => {
    expect(lerResumoVinculo(crua)).toEqual({
      cnpj: '10101010000101',
      resumo: { forca: 'forte', clientes: 2, nomes: ['C10B LTDA', 'C10A LTDA'], situacoes: ['02', '08'] },
    });
  });

  it('nome e situação nulos são tolerados (cliente sem foto da Receita)', () => {
    expect(lerResumoVinculo({ ...crua, clientes: 1, clientes_nomes: [null], clientes_situacoes: [null] }).resumo.nomes).toEqual([null]);
  });

  it.each([
    ['sem cnpj', { ...crua, cnpj: null }],
    ['força desconhecida', { ...crua, forca: 'veredito' }],
    ['zero clientes (sem vínculo não vem linha)', { ...crua, clientes: 0, clientes_nomes: [], clientes_situacoes: [] }],
    ['contagem que não bate com os nomes', { ...crua, clientes: 3 }],
    ['contagem fracionária', { ...crua, clientes: 1.5 }],
    ['situações não-lista', { ...crua, clientes_situacoes: '08' }],
    ['nome não-texto', { ...crua, clientes_nomes: [1, 2] }],
    ['linha nula', null],
  ])('LANÇA na forma inesperada: %s', (_, linha) => {
    expect(() => lerResumoVinculo(linha)).toThrow('radar_vinculos_por_cnpjs: resposta fora da forma esperada');
  });
});

describe('seloVinculo', () => {
  it('algum cliente do vínculo baixado/inapto → "possível sucessor", nomeando ESSE cliente', () => {
    const s = seloVinculo('ok', resumo());
    expect(s?.texto).toBe('possível sucessor');
    expect(s?.chave).toBe('sucessor');
    expect(s?.tom).toBe('warning');
    expect(s?.titulo).toMatch(/^Possível sucessor de C10A LTDA \(baixada na Receita\) \(\+1 outro cliente\) · há pista forte\./);
  });

  it('todos ativos → "possível vínculo" com o 1º (o mais forte); pista média em tom info', () => {
    const s = seloVinculo('ok', resumo({ forca: 'media', clientes: 1, nomes: ['C3 LTDA'], situacoes: ['02'] }));
    expect(s?.texto).toBe('possível vínculo');
    expect(s?.tom).toBe('info');
    expect(s?.titulo).toMatch(/^Possível vínculo com C3 LTDA · pista média\. Veja a evidência na ficha/);
  });

  it('o mapa de "fora de operação" é o MESMO da ficha (nula, suspensa, inapta, baixada)', () => {
    for (const sit of ['01', '03', '04', '08']) {
      expect(seloVinculo('ok', resumo({ clientes: 1, nomes: ['X'], situacoes: [sit] }))?.chave).toBe('sucessor');
      expect(seloVinculo('ok', resumo({ clientes: 1, nomes: ['X'], situacoes: [sit] }))?.titulo.split(' · ')[0])
        .toBe(tituloVinculo({ clienteNome: 'X', clienteSituacao: sit }));
    }
    expect(seloVinculo('ok', resumo({ clientes: 1, nomes: ['X'], situacoes: [null] }))?.chave).toBe('vinculo');
    expect(seloVinculo('ok', resumo({ clientes: 1, nomes: ['X'], situacoes: ['toString'] }))?.chave).toBe('vinculo');
  });

  it('leitura que falhou → "vínculo?" (não consegui verificar), nunca nenhum chip', () => {
    const s = seloVinculo('falhou', null);
    expect(s?.texto).toBe('vínculo?');
    expect(s?.tom).toBe('muted');
    expect(s?.titulo).toMatch(/Não consegui verificar/);
  });

  it('página lida sem vínculo, ou ainda carregando → nenhum chip', () => {
    expect(seloVinculo('ok', null)).toBeNull();
    expect(seloVinculo('carregando', null)).toBeNull();
    expect(seloVinculo('carregando', resumo())).toBeNull();
  });

  it('o chip nunca fala em parentesco nem em veredito', () => {
    const textos = [seloVinculo('ok', resumo()), seloVinculo('ok', resumo({ situacoes: ['02', '02'] })), seloVinculo('falhou', null)]
      .flatMap((s) => [s?.texto ?? '', s?.titulo ?? '']).join(' ');
    expect(textos).not.toMatch(/parente|c[oô]njuge|filho|é cliente|mesma pessoa/i);
  });
});
