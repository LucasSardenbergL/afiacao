import { describe, it, expect, beforeEach } from 'vitest';
import { diaMesData, diaUtil, diasAte, hojeBRT, opcoesRetorno, retornoPadrao, retornoValido, somarDias } from '../retorno';
import { gravarRascunhoNota, lerRascunhoNota, limparRascunhoNota } from '../rascunho-nota';
import { lerRegistroContato } from '../borda-rpc';
import { lerProspectarHoje } from '../prospectar-hoje';

/** Pacote G do Radar (migration 20261111100000): datas de retorno, rascunho da nota, bordas das RPCs. */
describe('retorno — dia civil BRT, mesma regra do servidor', () => {
  it('hoje é o dia de São Paulo (02:30Z de 09/11 ainda é 08/11 em BRT)', () => {
    expect(hojeBRT(new Date('2026-11-09T02:30:00Z'))).toBe('2026-11-08');
    expect(hojeBRT(new Date('2026-11-09T03:30:00Z'))).toBe('2026-11-09');
  });
  it('dia útil = private.radar_dia_util: sábado e domingo vão para segunda; sexta fica', () => {
    expect(diaUtil('2026-11-14')).toBe('2026-11-16');
    expect(diaUtil('2026-11-15')).toBe('2026-11-16');
    expect(diaUtil('2026-11-13')).toBe('2026-11-13');
  });
  it('sugestão padrão = hoje+7 em dia útil (o que o servidor usa sem data)', () => {
    expect(retornoPadrao('2026-11-09')).toBe('2026-11-16');
    expect(retornoPadrao('2026-11-07')).toBe('2026-11-16'); // sábado+7 = sábado → segunda
  });
  it('chips: hoje existe, exatamente um vem marcado e é o padrão', () => {
    const o = opcoesRetorno('2026-11-09');
    expect(o.map((x) => x.rotulo)).toEqual(['Hoje', 'Amanhã', 'Em 3 dias', 'Em 1 semana', 'Em 2 semanas']);
    expect(o.filter((x) => x.padrao).map((x) => x.dia)).toEqual(['2026-11-16']);
    expect(o[0].dia).toBe('2026-11-09');
  });
  it('faixa aceita: de hoje a hoje+60 (RD008 fora); formato inválido é inválido', () => {
    expect(retornoValido('2026-11-09', '2026-11-09')).toBe(true);
    expect(retornoValido(somarDias('2026-11-09', 60), '2026-11-09')).toBe(true);
    expect(retornoValido(somarDias('2026-11-09', 61), '2026-11-09')).toBe(false);
    expect(retornoValido('2026-11-08', '2026-11-09')).toBe(false);
    expect(retornoValido('', '2026-11-09')).toBe(false);
  });
  it('dd/mm sem passar por Date (new Date("YYYY-MM-DD") cairia no dia anterior em BRT)', () => {
    expect(diaMesData('2026-11-16')).toBe('16/11');
    expect(diasAte('2026-11-16', '2026-11-09')).toBe(7);
    expect(diasAte('2026-11-08', '2026-11-09')).toBe(-1);
  });
});

describe('rascunho da nota — nunca perder o texto do vendedor', () => {
  beforeEach(() => { limparRascunhoNota('u1:A'); limparRascunhoNota('u1:B'); limparRascunhoNota('u2:A'); });
  it('trocar de lead guarda e voltar restaura; a chave é usuário + CNPJ', () => {
    gravarRascunhoNota('u1:A', 'falei com o João');
    gravarRascunhoNota('u1:B', 'outra');
    expect(lerRascunhoNota('u1:A')).toBe('falei com o João');
    expect(lerRascunhoNota('u1:B')).toBe('outra');
    expect(lerRascunhoNota('u2:A')).toBe('');
  });
  it('só espaço não é rascunho; limpar apaga', () => {
    gravarRascunhoNota('u1:A', 'x');
    gravarRascunhoNota('u1:A', '   ');
    expect(lerRascunhoNota('u1:A')).toBe('');
    gravarRascunhoNota('u1:A', 'y');
    limparRascunhoNota('u1:A');
    expect(lerRascunhoNota('u1:A')).toBe('');
  });
});

describe('borda de registrar_contato_radar (pacote G)', () => {
  it('lê nota_gravada e retorno_em', () => {
    expect(lerRegistroContato({ id: 'c1', deduped: false, nota_gravada: true, retorno_em: '2026-11-16' }, 'r'))
      .toEqual({ id: 'c1', deduped: false, notaGravada: true, retornoEm: '2026-11-16', posse: null });
  });
  it('banco anterior (só {id, deduped}): null nos campos novos — nunca um true fabricado', () => {
    expect(lerRegistroContato({ id: 'c1', deduped: true }, 'r')).toEqual({ id: 'c1', deduped: true, notaGravada: null, retornoEm: null, posse: null });
  });
  it('forma errada lança (nunca "registrado" sem a resposta que o prova)', () => {
    expect(() => lerRegistroContato({ id: 'c1', deduped: false, nota_gravada: 'sim' }, 'r')).toThrow('{nota_gravada}');
    expect(() => lerRegistroContato({ id: 'c1', deduped: false, retorno_em: '16/11/2026' }, 'r')).toThrow('{retorno_em}');
  });
});

describe('card: retornos e posses (aditivo, ausente ≠ zero)', () => {
  const base = { territorio: [], leads: [], territorio_motivo: 'sem_carteira' };
  it('RPC anterior ao pacote G: retornos e posses null (não sei), nunca zero', () => {
    const d = lerProspectarHoje(base, 'c');
    expect(d.retornos).toBeNull();
    expect(d.posses).toBeNull();
  });
  it('lê retornos e posses do formato do servidor', () => {
    const d = lerProspectarHoje({
      ...base,
      retornos: { total: 2, itens: [
        { cnpj: '10100000000101', razao_social: 'Metal A', retorno_tipo: 'conversa', retorno_em: '2026-11-06', atrasado: true, nota: 'quer amostra' },
        { cnpj: '10500000000101', nome_fantasia: 'Lead 105', retorno_tipo: 'nao_atendeu', retorno_em: '2026-11-08', atrasado: false },
      ] },
      posses: { vencendo: [{ atendimento_id: 7, cnpj: '10400000000101', razao_social: 'L104', expira_em: '2026-11-09T03:00:00+00:00' }], vencidas_7d: 1 },
    }, 'c');
    expect(d.retornos?.total).toBe(2);
    expect(d.retornos?.itens.map((r) => `${r.tipo}:${r.atrasado}`)).toEqual(['conversa:true', 'nao_atendeu:false']);
    expect(d.posses).toEqual({ vencendo: [{ atendimentoId: 7, cnpj: '10400000000101', razaoSocial: 'L104', nomeFantasia: null, expiraEm: '2026-11-09T03:00:00+00:00' }], vencidas7d: 1 });
  });
  it('forma errada LANÇA: tipo desconhecido, data fora do formato, total menor que os itens, vencidas ausente', () => {
    const r = (itens: unknown[], total = itens.length) => () => lerProspectarHoje({ ...base, retornos: { total, itens } }, 'c');
    expect(r([{ cnpj: 'X', retorno_tipo: 'outro', retorno_em: '2026-11-06' }])).toThrow('retornos.itens[0]');
    expect(r([{ cnpj: 'X', retorno_tipo: 'conversa', retorno_em: '06/11' }])).toThrow('retornos.itens[0]');
    expect(r([{ cnpj: 'X', retorno_tipo: 'conversa', retorno_em: '2026-11-06' }], 0)).toThrow('retornos.total');
    expect(() => lerProspectarHoje({ ...base, posses: { vencendo: [] } }, 'c')).toThrow('posses.vencidas_7d');
  });
});
