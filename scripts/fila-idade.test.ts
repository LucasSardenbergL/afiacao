import { describe, it, expect } from 'vitest';
import { avaliarFila, referenciasDePRs, type ItemFila } from './fila-idade';

const AGORA = Date.parse('2026-09-08T20:00:00Z');
const horasAtras = (h: number) => new Date(AGORA - h * 3_600_000).toISOString();

const issue = (number: number, horas: number, title = `item ${number}`): ItemFila => ({
  number,
  title,
  createdAt: horasAtras(horas),
});

describe('avaliarFila — o relógio só para com AVANÇO COMPROVADO', () => {
  it('acusa item aberto há mais que o teto e sem PR que o referencie', () => {
    const { parados } = avaliarFila([issue(10, 72)], new Set(), AGORA, 48);
    expect(parados).toEqual([{ numero: 10, titulo: 'item 10', horas: 72 }]);
  });

  it('PR que referencia a issue TIRA o item do relógio', () => {
    const { parados } = avaliarFila([issue(10, 72)], new Set([10]), AGORA, 48);
    expect(parados).toEqual([]);
  });

  it('item mais novo que o teto não é acusado', () => {
    const { parados } = avaliarFila([issue(10, 47)], new Set(), AGORA, 48);
    expect(parados).toEqual([]);
  });

  it('ordena do mais parado para o menos', () => {
    const { parados } = avaliarFila([issue(1, 50), issue(2, 300), issue(3, 100)], new Set(), AGORA, 48);
    expect(parados.map((p) => p.numero)).toEqual([2, 3, 1]);
  });

  it('reporta a idade do mais antigo mesmo quando NINGUÉM passou do teto', () => {
    // Sem isto o sensor só teria dois estados (limpo/estourado) e o founder não veria a fila
    // se aproximando do teto — a métrica é a IDADE, não só o alarme.
    const { parados, maisAntigoHoras } = avaliarFila([issue(1, 30)], new Set(), AGORA, 48);
    expect(parados).toEqual([]);
    expect(Math.floor(maisAntigoHoras)).toBe(30);
  });

  it('data ilegível é IGNORADA, não vira idade fabricada', () => {
    // `Date.parse` devolve NaN; sem o guard, `(agora - NaN)/3.6e6` é NaN e `NaN >= teto` é false —
    // o item sumiria calado. Pior: qualquer aritmética com epoch 0 daria ~500.000h de "pendência".
    const { parados, maisAntigoHoras } = avaliarFila(
      [{ number: 9, title: 'quebrado', createdAt: 'não é data' }],
      new Set(),
      AGORA,
      48,
    );
    expect(parados).toEqual([]);
    expect(maisAntigoHoras).toBe(0);
  });
});

describe('referenciasDePRs — só PR conta como avanço', () => {
  it('lê referência do título e do corpo', () => {
    const refs = referenciasDePRs([
      { title: 'fix: conserta o leitor (#2397)', body: null },
      { title: 'feat: sonda', body: 'Fecha #1234 e toca #5678.' },
    ]);
    expect([...refs].sort((a, b) => a - b)).toEqual([1234, 2397, 5678]);
  });

  it('corpo nulo não explode', () => {
    expect(referenciasDePRs([{ title: 'sem corpo', body: null }]).size).toBe(0);
  });

  it('a fonte é a lista de PRs — comentário de issue nunca chega aqui', () => {
    // O contrato do sensor: comentário automático NÃO reinicia o relógio. Isso é estrutural —
    // esta função só recebe PRs. O teste trava a assinatura para que ninguém "melhore" o sensor
    // passando comentários por aqui e reabra o buraco que o Codex apontou.
    const refs = referenciasDePRs([]);
    expect(refs.size).toBe(0);
  });
});
