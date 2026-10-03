import { describe, expect, it } from 'vitest';
import type { ItemBacktest } from './dados';
import { coberturaSemGabarito, indexarResultados, predicoesBaseline, predicoesJev, type ResultadoChamada } from './relatorio';

const base = (id: string, gabarito: string[] | null, baseline: string | null): ItemBacktest => ({
  id,
  dominio: 'boletim_sku',
  grupo: `g:${id}`,
  tipoGabarito: gabarito === null ? 'sem_gabarito' : 'prata',
  state: {},
  instrucoes: 'q',
  opcoes: [
    { chave: 'a', descricao: null },
    { chave: 'b', descricao: null },
    { chave: 'nenhum', descricao: null },
  ],
  gabarito,
  baseline,
});

const ITENS = [base('i1', ['a'], 'a'), base('i2', ['nenhum'], null), base('i3', null, null)];

const okR = (id: string, ordem: ResultadoChamada['ordem'], escolha: string, probabilidades: Record<string, number>, confidence = 0.5): ResultadoChamada => ({
  id, ordem, ok: true, escolha, prob: probabilidades[escolha], probabilidades, confidence,
  tokensEntrada: 100, modelo: 'jev-1.13.0', tentativas: 1, latenciaMs: 120, latenciaTotalMs: 120,
});

const RES: ResultadoChamada[] = [
  okR('i1', 'direta', 'a', { a: 0.9, b: 0.05, nenhum: 0.05 }, 0.8),
  okR('i1', 'invertida', 'b', { a: 0.3, b: 0.6, nenhum: 0.1 }),
  okR('i2', 'direta', 'b', { a: 0.02, b: 0.95, nenhum: 0.03 }), // erro CONFIANTE num negativo
  { id: 'i2', ordem: 'invertida', ok: false, erro: 'HTTP 529', status: 529, tentativas: 5, latenciaTotalMs: 9000 },
  okR('i3', 'direta', 'nenhum', { a: 0.2, b: 0.1, nenhum: 0.7 }),
];

describe('predicoesJev — só itens COM gabarito; correta = escolha ∈ gabarito', () => {
  const idx = indexarResultados(RES);

  it('ordem direta, escore = prob da escolha', () => {
    const p = predicoesJev(ITENS, idx, 'direta', 'prob');
    expect(p.map((x) => x.id)).toEqual(['i1', 'i2']); // i3 (resíduo) fica de fora do acerto
    expect(p[0]).toMatchObject({ escolha: 'a', prob: 0.9, correta: true });
    expect(p[1]).toMatchObject({ escolha: 'b', prob: 0.95, correta: false });
  });

  it('escore = confidence (eixo secundário) troca só o escore, não a escolha', () => {
    const p = predicoesJev(ITENS, idx, 'direta', 'confidence');
    expect(p[0]).toMatchObject({ escolha: 'a', prob: 0.8, correta: true });
  });

  it('média das 2 ordens: combina as distribuições; se UMA ordem falhou, o item é FALHA (não usa a outra sozinha)', () => {
    const p = predicoesJev(ITENS, idx, 'media', 'prob');
    expect(p[0].escolha).toBe('a');
    expect(p[0].prob).toBeCloseTo(0.6, 10);
    expect(p[0].correta).toBe(true);
    expect(p[1]).toMatchObject({ escolha: null, prob: null, correta: false });
  });

  it('item sem nenhum resultado ⇒ FALHA contada (ausente ≠ acerto, ≠ abstenção)', () => {
    const p = predicoesJev([base('i9', ['a'], 'a')], idx, 'direta', 'prob');
    expect(p).toEqual([{ id: 'i9', grupo: 'g:i9', escolha: null, prob: null, correta: false }]);
  });
});

describe('predicoesBaseline', () => {
  it('escolha do baseline contra o gabarito; null = abstenção', () => {
    const p = predicoesBaseline(ITENS);
    expect(p).toEqual([
      { id: 'i1', grupo: 'g:i1', escolha: 'a', correta: true },
      { id: 'i2', grupo: 'g:i2', escolha: null, correta: false },
    ]);
  });
});

describe('coberturaSemGabarito — resíduo: quanto o Jev responderia, e quanto disso é "nenhum"', () => {
  it('limiar 0,5: i3 responde "nenhum"', () => {
    const r = coberturaSemGabarito(ITENS, indexarResultados(RES), 0.5);
    expect(r).toEqual({ total: 1, falhas: 0, respondidas: 1, respondeuNenhum: 1 });
  });
  it('limiar 0,8: i3 abstém', () => {
    const r = coberturaSemGabarito(ITENS, indexarResultados(RES), 0.8);
    expect(r.respondidas).toBe(0);
  });
});
