import { describe, it, expect } from 'vitest';
import {
  margemConhecida,
  mediaMargemConhecida,
  legendaCobertura,
  faixaMargem,
  formatarMargemPct,
  MARGEM_ALTA_PCT,
  MARGEM_MEDIA_PCT,
} from './index';

// Oráculo do consumo de `farmer_client_scores.gross_margin_pct` no front.
//
// Contexto medido em prod (2026-07-21): a coluna é `0` LITERAL em 6.632/6.632 linhas
// (`column_default = 0`). O PR produtor (#1495) passa a gravar NULL em 5.579 (84,1%) e
// PERCENTUAL 0-100 no resto. Os dois fatos abaixo é que este oráculo trava:
//
//   1. ausente ≠ zero — `0` é o VEREDITO "cliente não-lucrativo", não "não sei";
//   2. a escala é PERCENTUAL 0-100 (o PG17 do #1495 afirma "56.00" p/ 56%), e havia
//      consumidor comparando contra 0.3/0.15 (fração) e multiplicando por 100.

describe('margemConhecida', () => {
  it('trata 0 como CONHECIDO — margem nula real é um fato, não ausência', () => {
    expect(margemConhecida(0)).toBe(0);
  });

  it('preserva margem negativa (cliente vendido no prejuízo é dado real)', () => {
    expect(margemConhecida(-60)).toBe(-60);
  });

  it('preserva percentual positivo sem reescalar', () => {
    expect(margemConhecida(56)).toBe(56);
    expect(margemConhecida(0.5)).toBe(0.5); // 0,5% — NÃO é "50%"
  });

  it('degrada ausência para null, nunca para 0', () => {
    expect(margemConhecida(null)).toBeNull();
    expect(margemConhecida(undefined)).toBeNull();
  });

  it('degrada não-finito para null (NaN/Infinity não são margem)', () => {
    expect(margemConhecida(NaN)).toBeNull();
    expect(margemConhecida(Infinity)).toBeNull();
    expect(margemConhecida(-Infinity)).toBeNull();
  });

  it('aceita numeric serializado como string (PostgREST)', () => {
    expect(margemConhecida('56.00')).toBe(56);
    expect(margemConhecida('-60')).toBe(-60);
  });

  // Defesa em profundidade, NÃO bug medido: `numeric` do Postgres não produz "" nem " ".
  // Mas o tipo declarado nos hooks é `number | string | null`, e `Number('')` é 0 — a
  // fabricação exata que este módulo existe para impedir. Custa uma linha barrar.
  it('não deixa string vazia/branca virar 0 (Number("") === 0)', () => {
    expect(margemConhecida('')).toBeNull();
    expect(margemConhecida('   ')).toBeNull();
  });

  it('não deixa tipo não-numérico virar 0 (Number(false)/Number([]) === 0)', () => {
    expect(margemConhecida('abc')).toBeNull();
    expect(margemConhecida(false)).toBeNull();
    expect(margemConhecida([])).toBeNull();
    expect(margemConhecida({})).toBeNull();
  });
});

describe('mediaMargemConhecida', () => {
  it('exclui o desconhecido do numerador E do denominador', () => {
    // Com `|| 0`: (40 + 60 + 0 + 0) / 4 = 25 — um KPI que ninguém reconheceria como errado.
    // Correto: (40 + 60) / 2 = 50.
    const r = mediaMargemConhecida([40, 60, null, undefined]);
    expect(r.media).toBe(50);
    expect(r.comMargem).toBe(2);
    expect(r.total).toBe(4);
  });

  it('conta o 0 legítimo no denominador (é margem conhecida)', () => {
    const r = mediaMargemConhecida([60, 0]);
    expect(r.media).toBe(30);
    expect(r.comMargem).toBe(2);
  });

  it('nenhuma margem conhecida → media null, jamais 0', () => {
    const r = mediaMargemConhecida([null, null, undefined]);
    expect(r.media).toBeNull();
    expect(r.comMargem).toBe(0);
    expect(r.total).toBe(3);
  });

  it('lista vazia → media null (não NaN de 0/0)', () => {
    const r = mediaMargemConhecida([]);
    expect(r.media).toBeNull();
    expect(r.total).toBe(0);
  });

  it('reporta a cobertura no cenário real pós-#1495 (84% ausente)', () => {
    // 1.053 conhecidas de 6.632: a média representa 16% da base e a UI precisa dizer isso.
    const valores = [
      ...Array.from({ length: 1053 }, () => 50),
      ...Array.from({ length: 5579 }, () => null),
    ];
    const r = mediaMargemConhecida(valores);
    expect(r.media).toBe(50);
    expect(r.comMargem).toBe(1053);
    expect(r.total).toBe(6632);
  });
});

describe('legendaCobertura', () => {
  it('declara que a média é parcial quando falta margem', () => {
    expect(legendaCobertura(1053, 6632)).toBe('parcial — 1.053 de 6.632 clientes c/ margem');
  });

  it('não diz "parcial" quando todos os clientes têm margem', () => {
    expect(legendaCobertura(10, 10)).toBe('10 clientes c/ margem');
  });

  it('nenhum cliente com margem → diz isso em vez de mostrar cobertura 0', () => {
    expect(legendaCobertura(0, 6632)).toBe('nenhum cliente c/ margem conhecida');
  });

  it('base vazia não vira "0 de 0"', () => {
    expect(legendaCobertura(0, 0)).toBe('sem clientes');
  });
});

describe('faixaMargem', () => {
  it('classifica em PERCENTUAL 0-100, não em fração', () => {
    expect(faixaMargem(56)).toBe('alta');
    expect(faixaMargem(20)).toBe('media');
    expect(faixaMargem(5)).toBe('baixa');
  });

  // Regressão do bug de unidade: CustomerHero comparava `>= 0.3` contra uma coluna 0-100.
  // Pós-#1495 isso pintaria de VERDE qualquer cliente com margem acima de 0,3%.
  it('margem de 5% é BAIXA — não "alta" por passar de 0.3', () => {
    expect(faixaMargem(5)).not.toBe('alta');
  });

  it('margem de 0,5% é baixa (a fração 0.5 não vale 50%)', () => {
    expect(faixaMargem(0.5)).toBe('baixa');
  });

  it('respeita as fronteiras declaradas', () => {
    expect(faixaMargem(MARGEM_ALTA_PCT)).toBe('alta');
    expect(faixaMargem(MARGEM_ALTA_PCT - 0.01)).toBe('media');
    expect(faixaMargem(MARGEM_MEDIA_PCT)).toBe('media');
    expect(faixaMargem(MARGEM_MEDIA_PCT - 0.01)).toBe('baixa');
  });

  it('margem negativa é baixa, não desconhecida', () => {
    expect(faixaMargem(-60)).toBe('baixa');
  });

  it('ausente é "desconhecida" — não cai na faixa mais baixa', () => {
    expect(faixaMargem(null)).toBe('desconhecida');
    expect(faixaMargem(undefined)).toBe('desconhecida');
    expect(faixaMargem(NaN)).toBe('desconhecida');
  });

  it('0 conhecido é baixa (veredito real), não desconhecida', () => {
    expect(faixaMargem(0)).toBe('baixa');
  });
});

describe('formatarMargemPct', () => {
  it('mostra "—" para margem desconhecida, nunca um número', () => {
    expect(formatarMargemPct(null)).toBe('—');
    expect(formatarMargemPct(undefined)).toBe('—');
    expect(formatarMargemPct(NaN)).toBe('—');
  });

  it('não reescala: 56 é 56%, não 5600%', () => {
    expect(formatarMargemPct(56)).toBe('56%');
  });

  // Regressão da heurística `v > 1 ? v : v * 100` de formatPctMaybe: com margem negativa
  // (que o #1495 preserva) o ramo `false` multiplicava por 100 → "-6000%".
  it('margem negativa não é multiplicada por 100', () => {
    expect(formatarMargemPct(-60)).toBe('-60%');
  });

  it('margem abaixo de 1% não vira dezenas (0,5% ≠ 50%)', () => {
    expect(formatarMargemPct(0.5)).toBe('0,5%');
  });

  it('0 conhecido é exibido como 0%, não como "—"', () => {
    expect(formatarMargemPct(0)).toBe('0%');
  });

  it('usa vírgula decimal (pt-BR) e omite decimal quando inteiro', () => {
    expect(formatarMargemPct(56.4)).toBe('56,4%');
    expect(formatarMargemPct(56.04)).toBe('56%');
  });
});
