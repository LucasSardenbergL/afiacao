import { describe, expect, it } from 'vitest';
import {
  dataBr, documentoCompleto, lerPreviaSucessao, lerResultadoEscritaSucessao, lerSucessoesDoDocumento,
  mensagemRecusaSucessao, normalizarDocumento, resumoLado, textoEstadoSucessao, tituloSucessao,
} from '../sucessao';

const linha = (o: Record<string, unknown> = {}) => ({
  id: 'id1', evento_id: 'ev1', papel: 'novo', antigo_documento: '03166577000166', antigo_nome: 'DIVIMOVEIS',
  novo_documento: '69491768000101', novo_nome: 'MARQUES PLANEJADOS LTDA', tipo: 'cisao', data_corte: '2026-10-06',
  data_corte_sugerida: '2026-10-06', observacao: null, declarado_por_nome: 'Lucas',
  declarado_em: '2026-11-07T01:00:00+00:00', revogado_em: null, revogado_por_nome: null, revogado_motivo: null,
  estado: 'declarada', impedimento: 'novo_sem_cadastro', ...o,
});

describe('lerSucessoesDoDocumento', () => {
  it('lê a forma da RPC (versão + declarações)', () => {
    const r = lerSucessoesDoDocumento({ versao: 3, sucessoes: [linha()] });
    expect(r.versao).toBe(3);
    expect(r.sucessoes[0]).toMatchObject({ papel: 'novo', antigoNome: 'DIVIMOVEIS', estado: 'declarada', impedimento: 'novo_sem_cadastro' });
  });
  it('lista vazia é "sem sucessão" de verdade (com versão)', () => {
    expect(lerSucessoesDoDocumento({ versao: 0, sucessoes: [] })).toEqual({ versao: 0, sucessoes: [] });
  });
  it('resposta sem versão LANÇA (ausente ≠ vazio)', () => {
    expect(() => lerSucessoesDoDocumento({ sucessoes: [] })).toThrow('cliente_sucessoes_do_documento: resposta fora da forma esperada');
  });
  it('estado ou impedimento desconhecido LANÇA', () => {
    expect(() => lerSucessoesDoDocumento({ versao: 1, sucessoes: [linha({ estado: 'confirmado' })] }))
      .toThrow('cliente_sucessoes_do_documento: declaração fora da forma esperada');
    expect(() => lerSucessoesDoDocumento({ versao: 1, sucessoes: [linha({ impedimento: 'x' })] }))
      .toThrow('cliente_sucessoes_do_documento: declaração fora da forma esperada');
  });
});

describe('títulos e estado', () => {
  it('no novo: "Cisão confirmada de X"; no antigo: "Cindiu para Y"', () => {
    const s = lerSucessoesDoDocumento({ versao: 1, sucessoes: [linha(), linha({ papel: 'antigo', id: 'id2' })] }).sucessoes;
    expect(tituloSucessao(s[0])).toBe('Cisão confirmada de DIVIMOVEIS');
    expect(tituloSucessao(s[1])).toBe('Cindiu para MARQUES PLANEJADOS LTDA');
    expect(tituloSucessao({ ...s[0], tipo: 'sucessao', estado: 'revogada' })).toBe('Sucessão confirmada de DIVIMOVEIS (revogada)');
  });
  it('estado mostra o impedimento concreto, a vigência ou a revogação', () => {
    expect(textoEstadoSucessao({ estado: 'declarada', impedimento: 'novo_sem_cadastro', dataCorte: '2026-10-06' }))
      .toBe('O histórico só passa a valer depois do cadastro no Omie');
    expect(textoEstadoSucessao({ estado: 'declarada', impedimento: 'corte_futuro', dataCorte: '2026-12-01' }))
      .toBe('A data de corte ainda não chegou');
    expect(textoEstadoSucessao({ estado: 'ativa', impedimento: null, dataCorte: '2026-10-06' })).toBe('Vale a partir de 06/10/2026');
    expect(textoEstadoSucessao({ estado: 'revogada', impedimento: null, dataCorte: '2026-10-06' })).toBe('Revogada');
  });
});

describe('lerResultadoEscritaSucessao', () => {
  it('ok traz a versão nova', () => {
    expect(lerResultadoEscritaSucessao({ ok: true, versao: 2, antigo_nome: 'DIVIMOVEIS', novo_cadastrado: false }, 'x'))
      .toEqual({ ok: true, versao: 2, antigoNome: 'DIVIMOVEIS', novoCadastrado: false });
  });
  it('recusa traz o motivo; evento divergente explica tipo e corte', () => {
    const r = lerResultadoEscritaSucessao({ ok: false, motivo: 'evento_divergente', tipo: 'cisao', data_corte: '2026-10-06' }, 'x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(mensagemRecusaSucessao(r)).toBe(
      'Esse cliente antigo já tem uma cisão declarada com corte em 06/10/2026. A nova empresa entra no mesmo evento: use o mesmo tipo e a mesma data.',
    );
    const c = lerResultadoEscritaSucessao({ ok: false, motivo: 'cadeia' }, 'x');
    if (!c.ok) expect(mensagemRecusaSucessao(c)).toContain('encadear');
  });
  it('ok sem versão LANÇA (o front precisaria inventar a versão)', () => {
    expect(() => lerResultadoEscritaSucessao({ ok: true }, 'cliente_declarar_sucessao'))
      .toThrow('cliente_declarar_sucessao: resposta sem a versão nova');
  });
});

describe('prévia', () => {
  const lado = (o: Record<string, unknown> = {}) => ({
    documento: '03166577000166', nome: 'DIVIMOVEIS', cadastrado: true, candidatos: 1, pedidos_antes: 3,
    pedidos_a_partir: 1, primeiro_pedido: '2026-09-10', ultimo_pedido: '2026-10-06', datas_estimadas: 1,
    recentes: [{ dia: '2026-10-05', empresa: 'colacor', estimada: true, antes_do_corte: true }], ...o,
  });
  it('lê os dois lados e resume sem fabricar zero para quem não tem cadastro', () => {
    const p = lerPreviaSucessao({
      data_corte: '2026-10-06', abertura_novo: '2026-10-06', antigo: lado(),
      novo: lado({ documento: '69491768000101', nome: 'MARQUES', cadastrado: false, candidatos: 0,
        pedidos_antes: null, pedidos_a_partir: null, datas_estimadas: null, recentes: [] }),
    });
    expect(resumoLado(p.antigo)).toBe('3 pedido(s) antes do corte · 1 a partir dele (1 com data estimada)');
    expect(resumoLado(p.novo)).toBe('ainda sem cadastro de cliente');
  });
  it('pedido fora da forma LANÇA', () => {
    expect(() => lerPreviaSucessao({ data_corte: '2026-10-06', abertura_novo: null, antigo: lado({ recentes: [{ dia: 1 }] }), novo: lado() }))
      .toThrow('cliente_sucessao_previa: pedido fora da forma esperada');
  });
});

describe('documento', () => {
  it('normaliza máscara e reconhece CNPJ completo (inclusive alfanumérico)', () => {
    expect(normalizarDocumento('03.166.577/0001-66')).toBe('03166577000166');
    expect(documentoCompleto('03.166.577/0001-66')).toBe(true);
    expect(documentoCompleto('12ABC34501DE35')).toBe(true);
    expect(documentoCompleto('0316657')).toBe(false);
    expect(dataBr('2026-10-06')).toBe('06/10/2026');
    expect(dataBr(null)).toBe('—');
  });
});
