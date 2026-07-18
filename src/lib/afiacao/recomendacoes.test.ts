import { describe, it, expect } from 'vitest';
import {
  gerarRecomendacoes,
  filtrarRecomendacoes,
  resumirEconomia,
  CUSTO_MEDIO_FERRAMENTA_NOVA_BRL,
  type ToolInput,
  type EconomiaInput,
  type Recomendacao,
} from './recomendacoes';

// ── Datas de referência (construídas em horário LOCAL para não flakear por fuso) ──
// O helper parseia as strings com parseISO (local midnight), então comparar com um
// `hoje` também em local midnight mantém as bordas de dia estáveis em qualquer TZ.
const HOJE = new Date(2026, 6, 13); // 13 jul 2026

function tool(over: Partial<ToolInput> = {}): ToolInput {
  return {
    id: over.id ?? 'tool-1',
    nome: over.nome ?? 'Serra circular',
    next_sharpening_due: 'next_sharpening_due' in over ? over.next_sharpening_due! : null,
    last_sharpened_at: 'last_sharpened_at' in over ? over.last_sharpened_at! : null,
    sharpening_interval_days: 'sharpening_interval_days' in over ? over.sharpening_interval_days! : null,
    suggested_interval_days: 'suggested_interval_days' in over ? over.suggested_interval_days! : null,
  };
}

function economia(over: Partial<EconomiaInput> = {}): EconomiaInput {
  return {
    totalAfiacoes: over.totalAfiacoes ?? 0,
    totalGastoReal: over.totalGastoReal ?? 0,
  };
}

function pick<T extends Recomendacao['tipo']>(recs: Recomendacao[], tipo: T) {
  return recs.find((r) => r.tipo === tipo) as Extract<Recomendacao, { tipo: T }> | undefined;
}

describe('gerarRecomendacoes — possivelmente_atrasada (não-agendada)', () => {
  it('sinaliza ferramenta não-agendada cuja última afiação + intervalo já passou', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ id: 'a', nome: 'Plaina', last_sharpened_at: '2026-06-01', sharpening_interval_days: 30 })],
      economia: null,
      hoje: HOJE,
    });
    const r = pick(recs, 'possivelmente_atrasada');
    expect(r).toBeDefined();
    expect(r!.ferramentas).toEqual([{ id: 'a', nome: 'Plaina' }]);
  });

  it('NÃO sinaliza quando a projeção última+intervalo ainda está no futuro', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: '2026-07-10', sharpening_interval_days: 30 })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'possivelmente_atrasada')).toBeUndefined();
  });

  it('NÃO sinaliza sem last_sharpened_at, mesmo com intervalo (ausente ≠ atrasada)', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: null, sharpening_interval_days: 30 })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'possivelmente_atrasada')).toBeUndefined();
    // sem last não é "atrasada" — mas cadastrada-sem-afiação vira nunca_afiada, não sem_programacao
    expect(pick(recs, 'sem_programacao')).toBeUndefined();
    expect(pick(recs, 'nunca_afiada')).toBeDefined();
  });

  it('NÃO sinaliza sem intervalo algum (ferramenta nem categoria)', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: '2026-01-01', sharpening_interval_days: null, suggested_interval_days: null })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'possivelmente_atrasada')).toBeUndefined();
  });

  it('NÃO duplica o PriorityCard: ferramenta AGENDADA vencida não entra em possivelmente_atrasada', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ next_sharpening_due: '2026-07-01', last_sharpened_at: '2026-06-01', sharpening_interval_days: 30 })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'possivelmente_atrasada')).toBeUndefined();
  });

  it('usa suggested_interval_days da categoria quando a ferramenta não tem intervalo próprio', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ id: 'c', nome: 'Broca', last_sharpened_at: '2026-06-01', sharpening_interval_days: null, suggested_interval_days: 30 })],
      economia: null,
      hoje: HOJE,
    });
    const r = pick(recs, 'possivelmente_atrasada');
    expect(r?.ferramentas).toEqual([{ id: 'c', nome: 'Broca' }]);
  });

  it('borda: última + intervalo == hoje ainda NÃO é atrasada (só estritamente antes)', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: '2026-06-13', sharpening_interval_days: 30 })], // 2026-07-13 == hoje
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'possivelmente_atrasada')).toBeUndefined();
  });
});

describe('gerarRecomendacoes — nunca_afiada (cadastrada, sem afiação alguma)', () => {
  it('sinaliza ferramenta sem agendamento E sem última afiação (as 4 de produção)', () => {
    const recs = gerarRecomendacoes({
      // caso REAL: next_due NULL, last NULL, sem intervalo próprio, categoria dá 120
      tools: [tool({ id: 'w', nome: 'Serra Circular de Widea', suggested_interval_days: 120 })],
      economia: null,
      hoje: HOJE,
    });
    const r = pick(recs, 'nunca_afiada');
    expect(r?.ferramentas).toEqual([{ id: 'w', nome: 'Serra Circular de Widea' }]);
  });

  it('dispara MESMO com intervalo definido — o intervalo não substitui a 1ª afiação', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ id: 'i', nome: 'Plaina', sharpening_interval_days: 30 })], // last/next NULL
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'nunca_afiada')?.ferramentas).toEqual([{ id: 'i', nome: 'Plaina' }]);
    // e NÃO cai em sem_programacao (nunca_afiada tem precedência) nem em possivelmente_atrasada
    expect(pick(recs, 'sem_programacao')).toBeUndefined();
    expect(pick(recs, 'possivelmente_atrasada')).toBeUndefined();
  });

  it('precede sem_programacao: ferramenta all-null é nunca_afiada, nunca sem_programacao', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ next_sharpening_due: null, last_sharpened_at: null, sharpening_interval_days: null, suggested_interval_days: null })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'nunca_afiada')).toBeDefined();
    expect(pick(recs, 'sem_programacao')).toBeUndefined();
  });

  it('é exclusiva de possivelmente_atrasada: quem já afiou (last set) não é nunca_afiada', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: '2026-06-01', sharpening_interval_days: 30 })], // vencida
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'nunca_afiada')).toBeUndefined();
    expect(pick(recs, 'possivelmente_atrasada')).toBeDefined();
  });

  it('NÃO sinaliza ferramenta já agendada (tem next_due), mesmo sem last', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ next_sharpening_due: '2026-08-01', last_sharpened_at: null })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'nunca_afiada')).toBeUndefined();
  });
});

describe('gerarRecomendacoes — sem_programacao (já afiou, mas sem cadência)', () => {
  it('sinaliza ferramenta que JÁ afiou, sem next_due e sem intervalo algum', () => {
    const recs = gerarRecomendacoes({
      // last set (já afiou) isola sem_programacao de nunca_afiada
      tools: [tool({ id: 'x', nome: 'Faca', last_sharpened_at: '2026-01-01', next_sharpening_due: null, sharpening_interval_days: null, suggested_interval_days: null })],
      economia: null,
      hoje: HOJE,
    });
    const r = pick(recs, 'sem_programacao');
    expect(r?.ferramentas).toEqual([{ id: 'x', nome: 'Faca' }]);
    expect(pick(recs, 'nunca_afiada')).toBeUndefined();
  });

  it('NÃO sinaliza quando há intervalo (existe base para lembrete)', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: '2026-07-10', next_sharpening_due: null, sharpening_interval_days: 45 })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'sem_programacao')).toBeUndefined();
  });

  it('NÃO sinaliza ferramenta nunca afiada (essa é nunca_afiada, não sem_programacao)', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: null, next_sharpening_due: null, sharpening_interval_days: null })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'sem_programacao')).toBeUndefined();
    expect(pick(recs, 'nunca_afiada')).toBeDefined();
  });

  it('NÃO sinaliza ferramenta já agendada (tem next_due)', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ last_sharpened_at: '2026-01-01', next_sharpening_due: '2026-08-01', sharpening_interval_days: null, suggested_interval_days: null })],
      economia: null,
      hoje: HOJE,
    });
    expect(pick(recs, 'sem_programacao')).toBeUndefined();
  });
});

describe('gerarRecomendacoes — economia (comprovada + potencial)', () => {
  it('sem objeto de economia → sem card de economia', () => {
    const recs = gerarRecomendacoes({ tools: [], economia: null, hoje: HOJE });
    expect(pick(recs, 'economia')).toBeUndefined();
  });

  it('degrada (sem card) quando não há afiações — evita 0/0', () => {
    const recs = gerarRecomendacoes({ tools: [], economia: economia({ totalAfiacoes: 0, totalGastoReal: 0 }), hoje: HOJE });
    expect(pick(recs, 'economia')).toBeUndefined();
  });

  it('degrada (sem card) quando o gasto real é 0 (dado suspeito, não infla)', () => {
    const recs = gerarRecomendacoes({ tools: [], economia: economia({ totalAfiacoes: 5, totalGastoReal: 0 }), hoje: HOJE });
    expect(pick(recs, 'economia')).toBeUndefined();
  });

  it('economia comprovada = afiações × custo-nova − gasto real', () => {
    const recs = gerarRecomendacoes({
      tools: [],
      economia: economia({ totalAfiacoes: 10, totalGastoReal: 500 }),
      hoje: HOJE,
    });
    const r = pick(recs, 'economia');
    expect(r?.economiaComprovada).toBe(10 * CUSTO_MEDIO_FERRAMENTA_NOVA_BRL - 500); // 2000
    expect(r?.economiaPotencial).toBeNull(); // sem ferramentas atrasadas
  });

  it('degrada (sem card) quando a economia comprovada seria ≤ 0', () => {
    const recs = gerarRecomendacoes({
      tools: [],
      economia: economia({ totalAfiacoes: 1, totalGastoReal: 250 }), // 1×250−250 = 0
      hoje: HOJE,
    });
    expect(pick(recs, 'economia')).toBeUndefined();
  });

  it('economia potencial = nAtrasadas × (custo-nova − custo-médio-real)', () => {
    const recs = gerarRecomendacoes({
      // 1 agendada-vencida + 1 possivelmente-atrasada = 2 atrasadas
      tools: [
        tool({ id: 'v', next_sharpening_due: '2026-07-01' }),
        tool({ id: 'p', last_sharpened_at: '2026-06-01', sharpening_interval_days: 30 }),
      ],
      economia: economia({ totalAfiacoes: 10, totalGastoReal: 500 }), // custo médio = 50
      hoje: HOJE,
    });
    const r = pick(recs, 'economia');
    // 2 × (250 − 50) = 400
    expect(r?.economiaComprovada).toBe(2000);
    expect(r?.economiaPotencial).toBe(2 * (CUSTO_MEDIO_FERRAMENTA_NOVA_BRL - 50));
    expect(r?.nAtrasadas).toBe(2);
  });

  it('economia potencial é null quando não há ferramentas atrasadas', () => {
    const recs = gerarRecomendacoes({
      tools: [tool({ next_sharpening_due: '2026-08-01' })], // agendada futura, não atrasada
      economia: economia({ totalAfiacoes: 10, totalGastoReal: 500 }),
      hoje: HOJE,
    });
    const r = pick(recs, 'economia');
    expect(r?.economiaComprovada).toBe(2000);
    expect(r?.economiaPotencial).toBeNull();
  });
});

describe('gerarRecomendacoes — composição e ordem', () => {
  it('input vazio → sem recomendações', () => {
    expect(gerarRecomendacoes({ tools: [], economia: null, hoje: HOJE })).toEqual([]);
  });

  it('ordena: possivelmente_atrasada → nunca_afiada → sem_programacao → economia', () => {
    const recs = gerarRecomendacoes({
      tools: [
        tool({ id: 'p', last_sharpened_at: '2026-06-01', sharpening_interval_days: 30 }), // possivelmente atrasada
        tool({ id: 'n', next_sharpening_due: null, last_sharpened_at: null }), // nunca afiada
        tool({ id: 's', last_sharpened_at: '2026-01-01', next_sharpening_due: null, sharpening_interval_days: null }), // sem programação (já afiou)
      ],
      economia: economia({ totalAfiacoes: 10, totalGastoReal: 500 }),
      hoje: HOJE,
    });
    expect(recs.map((r) => r.tipo)).toEqual(['possivelmente_atrasada', 'nunca_afiada', 'sem_programacao', 'economia']);
  });
});

describe('resumirEconomia — parse defensivo dos itens (jsonb)', () => {
  it('soma quantidades dos itens e os totais dos pedidos', () => {
    const res = resumirEconomia([
      { items: [{ quantity: 2 }, { quantity: 3 }], total: 300 },
      { items: [{ quantity: 1 }], total: 100 },
    ]);
    expect(res).toEqual({ totalAfiacoes: 6, totalGastoReal: 400 });
  });

  it('item sem quantity conta como 1 (espelha o SavingsDashboard)', () => {
    const res = resumirEconomia([{ items: [{}, {}], total: 80 }]);
    expect(res.totalAfiacoes).toBe(2);
  });

  it('items ausente/não-array e total nulo não quebram nem fabricam número', () => {
    const res = resumirEconomia([
      { items: null, total: null },
      { items: undefined as unknown as unknown[], total: 50 },
    ]);
    expect(res).toEqual({ totalAfiacoes: 0, totalGastoReal: 50 });
  });
});

describe('filtrarRecomendacoes — corte de apresentação por tela', () => {
  const atrasada: Recomendacao = { tipo: 'possivelmente_atrasada', ferramentas: [{ id: 'a', nome: 'Serra' }] };
  const semProg: Recomendacao = { tipo: 'sem_programacao', ferramentas: [{ id: 'b', nome: 'Faca' }] };
  const eco: Recomendacao = { tipo: 'economia', economiaComprovada: 500, economiaPotencial: 100, nAtrasadas: 2 };
  const todas: Recomendacao[] = [atrasada, semProg, eco];

  it('sem tipos a ocultar → devolve tudo na mesma ordem', () => {
    expect(filtrarRecomendacoes(todas, [])).toEqual(todas);
  });

  it("oculta 'economia' (a Central já tem o herói) preservando as consultivas", () => {
    const r = filtrarRecomendacoes(todas, ['economia']);
    expect(r.map((x) => x.tipo)).toEqual(['possivelmente_atrasada', 'sem_programacao']);
  });

  it('ocultar todos os tipos presentes → lista vazia (dispara o null no componente)', () => {
    expect(filtrarRecomendacoes(todas, ['possivelmente_atrasada', 'sem_programacao', 'economia'])).toEqual([]);
  });

  it('é puro: não muta o array de entrada', () => {
    const entrada = [...todas];
    filtrarRecomendacoes(entrada, ['economia']);
    expect(entrada).toEqual(todas);
  });
});
