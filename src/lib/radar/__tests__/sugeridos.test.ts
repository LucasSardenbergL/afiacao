import { describe, expect, it } from 'vitest';
import {
  LIMIAR_SUGERIDO,
  cadastravelNoOmie,
  sugeridoParaCadastro,
  ehSugerido,
  elegivelCadastroPosSinal,
  estadoCardSugeridos,
  type LeadSugerivel,
} from '../sugeridos';

/** Lead "perfeito": na foto vigente, em conversa, não cliente, RFB ativa, score no limiar. */
const base: LeadSugerivel = {
  cnpj: '12345678000195',
  ja_cliente: false,
  omie_codigo_cliente: null,
  prospeccao_status: 'em_conversa',
  ultimo_lote: '2026-08',
  rfb_situacao: '02',
  score: LIMIAR_SUGERIDO,
};
const LOTE = { mes_referencia: '2026-08' };

describe('LIMIAR_SUGERIDO', () => {
  it('é 70 — medido em prod 2026-10-20: 852 leads ativos não-cliente ≥ 70 (12.434 ≥ 60, 33 ≥ 80)', () => {
    expect(LIMIAR_SUGERIDO).toBe(70);
  });
});

describe('cadastravelNoOmie (gatilho pós-sinal)', () => {
  it('aceita lead não-cliente, sem vínculo Omie, CNPJ numérico e RFB ativa', () => {
    expect(cadastravelNoOmie(base)).toEqual({ ok: true });
  });
  it('RFB desconhecida (null) NÃO bloqueia — ausente ≠ baixado', () => {
    expect(cadastravelNoOmie({ ...base, rfb_situacao: null })).toEqual({ ok: true });
  });
  it('recusa já cliente', () => {
    expect(cadastravelNoOmie({ ...base, ja_cliente: true })).toEqual({ ok: false, motivo: 'ja_cliente' });
  });
  it('recusa quem já tem código Omie mesmo com ja_cliente=false (vínculo é a prova)', () => {
    expect(cadastravelNoOmie({ ...base, omie_codigo_cliente: '4242' })).toEqual({ ok: false, motivo: 'ja_vinculado_omie' });
  });
  it.each(['08', '04', '03', '01'])('recusa RFB %s (baixado/inapto/suspenso/nulo)', (s) => {
    expect(cadastravelNoOmie({ ...base, rfb_situacao: s })).toEqual({ ok: false, motivo: 'rfb_nao_ativa' });
  });
  it('recusa CNPJ alfanumérico (a edge do Omie ainda não suporta — não oferecer o que vai falhar)', () => {
    expect(cadastravelNoOmie({ ...base, cnpj: '12ABC34501DE35' })).toEqual({ ok: false, motivo: 'cnpj_alfanumerico' });
  });
  it('elegivelCadastroPosSinal é o booleano do mesmo predicado', () => {
    expect(elegivelCadastroPosSinal(base)).toBe(true);
    expect(elegivelCadastroPosSinal({ ...base, ja_cliente: true })).toBe(false);
  });
});

describe('sugeridoParaCadastro (fila de qualificação)', () => {
  it('sugere: cadastrável + em_conversa + foto vigente + score ≥ limiar', () => {
    expect(sugeridoParaCadastro(base, LOTE)).toEqual({ ok: true });
    expect(ehSugerido(base, LOTE)).toBe(true);
  });
  it('score exatamente no limiar entra; um abaixo não', () => {
    expect(ehSugerido({ ...base, score: LIMIAR_SUGERIDO }, LOTE)).toBe(true);
    expect(sugeridoParaCadastro({ ...base, score: LIMIAR_SUGERIDO - 1 }, LOTE)).toEqual({ ok: false, motivo: 'score_abaixo' });
  });
  it('sem score (null) não é sugerido — e o motivo é "sem_score", nunca "abaixo"', () => {
    expect(sugeridoParaCadastro({ ...base, score: null }, LOTE)).toEqual({ ok: false, motivo: 'sem_score' });
  });
  it('sem lote vigente ninguém é sugerido (não sei qual é a foto)', () => {
    expect(sugeridoParaCadastro(base, null)).toEqual({ ok: false, motivo: 'sem_lote' });
  });
  it('quem saiu do dump não é sugerido', () => {
    expect(sugeridoParaCadastro({ ...base, ultimo_lote: '2026-05' }, LOTE)).toEqual({ ok: false, motivo: 'saiu_do_dump' });
  });
  it('lote em ingestão (ultimo_lote > vigente) também não é a foto', () => {
    expect(sugeridoParaCadastro({ ...base, ultimo_lote: '2026-11' }, LOTE)).toEqual({ ok: false, motivo: 'saiu_do_dump' });
  });
  it.each(['a_contatar', 'contatado_sem_resposta', 'descartado', 'virou_cliente', null])(
    'status %s não é sinal comercial — só em_conversa sugere',
    (status) => {
      expect(sugeridoParaCadastro({ ...base, prospeccao_status: status }, LOTE)).toEqual({ ok: false, motivo: 'sem_sinal' });
    },
  );
  it('já cliente / baixado herdam a recusa do cadastrável', () => {
    expect(sugeridoParaCadastro({ ...base, ja_cliente: true }, LOTE)).toEqual({ ok: false, motivo: 'ja_cliente' });
    expect(sugeridoParaCadastro({ ...base, rfb_situacao: '08' }, LOTE)).toEqual({ ok: false, motivo: 'rfb_nao_ativa' });
  });
});

describe('estadoCardSugeridos', () => {
  it('sem lote completo → "sem_lote" (sem número)', () => {
    expect(estadoCardSugeridos({ lote: null, temScore: true, sugeridos: 0 })).toEqual({ tipo: 'sem_lote' });
  });
  it('lote sem NENHUM score calculado → "sem_score" — nunca "0 sugeridos"', () => {
    expect(estadoCardSugeridos({ lote: LOTE, temScore: false, sugeridos: 0 })).toEqual({ tipo: 'sem_score' });
  });
  it('contagem ausente (leitura não concluída) → "carregando", não 0', () => {
    expect(estadoCardSugeridos({ lote: LOTE, temScore: true, sugeridos: undefined })).toEqual({ tipo: 'carregando' });
    expect(estadoCardSugeridos({ lote: LOTE, temScore: undefined, sugeridos: 3 })).toEqual({ tipo: 'carregando' });
  });
  it('com score calculado, 0 sugeridos é um ZERO legítimo', () => {
    expect(estadoCardSugeridos({ lote: LOTE, temScore: true, sugeridos: 0 })).toEqual({ tipo: 'pronto', n: 0 });
    expect(estadoCardSugeridos({ lote: LOTE, temScore: true, sugeridos: 12 })).toEqual({ tipo: 'pronto', n: 12 });
  });
});
