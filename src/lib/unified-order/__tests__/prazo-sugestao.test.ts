import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classificarDecisao,
  DEGRAUS_PRAZO_PEDIDO,
  dominaCalendario,
  faixaVencido,
  parseCalendarioParcela,
  prazoDaParcela,
  sugerirParcela,
  type FormaLegivel,
} from '../prazo-sugestao';

// Descrições REAIS que a edge omie-vendas-sync devolve/fallback (geral/parcelas/ do Omie).
const FORMAS = [
  { codigo: '999', descricao: 'A Vista' },
  { codigo: '000', descricao: 'A Vista (faturamento)' },
  { codigo: '001', descricao: '30 dias' },
  { codigo: '002', descricao: '30/60 dias' },
  { codigo: '003', descricao: '30/60/90 dias' },
  { codigo: '030', descricao: '30dd' },
  { codigo: 'A03', descricao: '30/60/90 DDL' },
  { codigo: 'A04', descricao: '28/56/84 DDL' },
  { codigo: 'B01', descricao: 'Boleto' },
  { codigo: 'C01', descricao: 'Cartão de crédito' },
  { codigo: 'E30', descricao: 'Entrada + 30' },
];

describe('parseCalendarioParcela — fail-closed (ausente ≠ zero)', () => {
  it('à vista nas grafias do Omie → [0]', () => {
    expect(parseCalendarioParcela('A Vista')).toEqual([0]);
    expect(parseCalendarioParcela('A Vista (faturamento)')).toEqual([0]);
    expect(parseCalendarioParcela('À VISTA')).toEqual([0]);
    expect(parseCalendarioParcela('a vista')).toEqual([0]);
  });
  it('"A Vista" com qualificador que contradiz (30 dias) é ilegível — só "(faturamento)" é permitido', () => {
    expect(parseCalendarioParcela('A Vista (30 dias)')).toBeNull();
    expect(parseCalendarioParcela('A Vista boleto')).toBeNull();
  });
  it('prazo único: "30 dias", "30dd", "30 DDL"', () => {
    expect(parseCalendarioParcela('30 dias')).toEqual([30]);
    expect(parseCalendarioParcela('30dd')).toEqual([30]);
    expect(parseCalendarioParcela('45 DDL')).toEqual([45]);
  });
  it('calendário: "30/60/90 DDL", "28/56/84 DDL" → lista crescente', () => {
    expect(parseCalendarioParcela('30/60/90 DDL')).toEqual([30, 60, 90]);
    expect(parseCalendarioParcela('28/56/84 DDL')).toEqual([28, 56, 84]);
    expect(parseCalendarioParcela('30/60 dias')).toEqual([30, 60]);
  });
  it('ilegível → null, NUNCA 0 (Boleto não é à vista)', () => {
    expect(parseCalendarioParcela('Boleto')).toBeNull();
    expect(parseCalendarioParcela('Cartão de crédito')).toBeNull();
    expect(parseCalendarioParcela('Entrada + 30')).toBeNull();
    expect(parseCalendarioParcela('')).toBeNull();
    expect(parseCalendarioParcela('  ')).toBeNull();
    expect(parseCalendarioParcela(undefined)).toBeNull();
  });
  it('calendário fora de ordem ou com repetição é ilegível (não reordena em silêncio)', () => {
    expect(parseCalendarioParcela('60/30 dias')).toBeNull();
    expect(parseCalendarioParcela('30/30 dias')).toBeNull();
  });
  it('número absurdo (> 365 dias, 0 com rótulo de dias) é ilegível', () => {
    expect(parseCalendarioParcela('999 dias')).toBeNull();
    expect(parseCalendarioParcela('0 dias')).toBeNull();
  });
  it('prazoDaParcela = parcela mais longa (média de 30/60/90 não é condição)', () => {
    expect(prazoDaParcela([30, 60, 90])).toBe(90);
    expect(prazoDaParcela([0])).toBe(0);
  });
});

describe('sugerirParcela — degrau abaixo, nunca inventa condição', () => {
  const base = { formas: FORMAS, vencido: 1500, diasVencidoMax: 12 };

  it('sem vencido → nenhuma (sem motivo de sistema: não há aviso)', () => {
    expect(sugerirParcela({ ...base, vencido: 0, parcelaAtual: '003' })).toEqual({ tipo: 'nenhuma', motivoSistema: null });
    expect(sugerirParcela({ ...base, vencido: null, parcelaAtual: '003' })).toEqual({ tipo: 'nenhuma', motivoSistema: null });
  });
  it('atual 30/60/90 (prazo 90) → degrau 75 → melhor forma legível ≤ 75 = 30/60 (60)', () => {
    const s = sugerirParcela({ ...base, parcelaAtual: '003' });
    expect(s.tipo).toBe('degrau');
    if (s.tipo === 'degrau') {
      expect(s.sugerida.codigo).toBe('002');
      expect(s.prazoAtual).toBe(90);
      expect(s.prazoSugerido).toBe(60);
    }
  });
  it('atual 28/56/84 → nenhuma forma da lista DOMINA (30/60 recebe 0% no dia 28 vs 1/3) → à vista', () => {
    const s = sugerirParcela({ ...base, parcelaAtual: 'A04' });
    expect(s.tipo === 'degrau' && s.sugerida.codigo).toBe('999');
  });
  it('"75 dias" único NÃO é sugerido para 30/60/90: antecipa o último vencimento mas atrasa a média (60→75)', () => {
    const formas: FormaLegivel[] = [...FORMAS, { codigo: 'P75', descricao: '75 dias' }];
    const s = sugerirParcela({ ...base, formas, parcelaAtual: '003' });
    expect(s.tipo === 'degrau' && s.sugerida.codigo).toBe('002');
  });
  it('prazo já no degrau mínimo (7 dias) → prazo_ja_curto, nunca 7→0 por fallback', () => {
    const formas: FormaLegivel[] = [...FORMAS, { codigo: 'P07', descricao: '7 dias' }];
    expect(sugerirParcela({ ...base, formas, parcelaAtual: 'P07' })).toEqual({ tipo: 'nenhuma', motivoSistema: 'prazo_ja_curto' });
  });
  it('atual "30 dias" → degrau 28 → nenhuma forma com 1..28 → à vista', () => {
    const s = sugerirParcela({ ...base, parcelaAtual: '001' });
    expect(s.tipo).toBe('degrau');
    if (s.tipo === 'degrau') {
      expect(s.sugerida.codigo).toBe('999'); // a 1ª à vista da lista, nunca "Boleto"
      expect(s.prazoSugerido).toBe(0);
    }
  });
  it('entre candidatas que dominam, a MENOS agressiva (maior média) é o degrau: "30 dias" antes de "15/30"', () => {
    const formas: FormaLegivel[] = [
      { codigo: 'X', descricao: '15/30 dias' },
      { codigo: 'Y', descricao: '30 dias' },
      { codigo: '999', descricao: 'A Vista' },
    ];
    const s = sugerirParcela({ ...base, formas, parcelaAtual: 'Z', formaAtualDescricao: '45 dias' });
    expect(s.tipo === 'degrau' && s.sugerida.codigo).toBe('Y');
  });
  it('atual já à vista → nenhuma com motivo ja_a_vista', () => {
    expect(sugerirParcela({ ...base, parcelaAtual: '999' })).toEqual({ tipo: 'nenhuma', motivoSistema: 'ja_a_vista' });
  });
  it('atual ilegível (Boleto) → nenhuma com motivo condicao_ilegivel (precisão > recall)', () => {
    expect(sugerirParcela({ ...base, parcelaAtual: 'B01' })).toEqual({ tipo: 'nenhuma', motivoSistema: 'condicao_ilegivel' });
  });
  it('atual não está na lista e sem descrição conhecida → condicao_ilegivel', () => {
    expect(sugerirParcela({ ...base, parcelaAtual: 'ZZZ' })).toEqual({ tipo: 'nenhuma', motivoSistema: 'condicao_ilegivel' });
  });
  it('vencido há mais de 60 dias → à vista direto (o gate já exige exceção; degrau não cabe)', () => {
    const s = sugerirParcela({ ...base, diasVencidoMax: 61, parcelaAtual: '003' });
    expect(s.tipo).toBe('degrau');
    if (s.tipo === 'degrau') {
      expect(s.sugerida.codigo).toBe('999');
      expect(s.motivo).toBe('vencido_60d');
    }
  });
  it('sem forma à vista e sem forma menor → nenhuma com sem_forma_menor (não fabrica código)', () => {
    const formas: FormaLegivel[] = [{ codigo: '001', descricao: '30 dias' }, { codigo: 'B01', descricao: 'Boleto' }];
    expect(sugerirParcela({ ...base, formas, parcelaAtual: '001' })).toEqual({ tipo: 'nenhuma', motivoSistema: 'sem_forma_menor' });
  });
  it('vencido NaN/Infinity é tratado como ausente (nenhuma)', () => {
    expect(sugerirParcela({ ...base, vencido: Number.NaN, parcelaAtual: '003' }).tipo).toBe('nenhuma');
    expect(sugerirParcela({ ...base, vencido: Number.POSITIVE_INFINITY, parcelaAtual: '003' }).tipo).toBe('nenhuma');
  });
});

describe('dominaCalendario — fração recebida nunca abaixo da atual', () => {
  it('30/60 domina 30/60/90; 75 não domina 30/60/90; à vista domina tudo', () => {
    expect(dominaCalendario([30, 60], [30, 60, 90])).toBe(true);
    expect(dominaCalendario([75], [30, 60, 90])).toBe(false);
    expect(dominaCalendario([60], [30, 60, 90])).toBe(false);
    expect(dominaCalendario([0], [30, 60, 90])).toBe(true);
  });
  it('igual a si mesmo não domina (exige ganho em algum dia)', () => {
    expect(dominaCalendario([30, 60], [30, 60])).toBe(false);
  });
  it('30/60 não domina 28/56/84 (no dia 28 recebe 0 vs 1/3)', () => {
    expect(dominaCalendario([30, 60], [28, 56, 84])).toBe(false);
    expect(dominaCalendario([28, 56], [28, 56, 84])).toBe(true);
  });
});

describe('classificarDecisao — o que vai para venda_prazo_decisao', () => {
  it('escolhida = sugerida → aceitou (mesmo sem clicar em Aplicar)', () => {
    expect(classificarDecisao({ sugerida: '002', escolhida: '002', interagiu: false, motivo: null })).toEqual({ decisao: 'aceitou', motivo: null });
  });
  it('manteve outra com interação + motivo → recusou', () => {
    expect(classificarDecisao({ sugerida: '002', escolhida: '003', interagiu: true, motivo: 'cliente_combinou_pagamento' }))
      .toEqual({ decisao: 'recusou', motivo: 'cliente_combinou_pagamento' });
  });
  it('não interagiu e manteve outra → ignorou (sem motivo)', () => {
    expect(classificarDecisao({ sugerida: '002', escolhida: '003', interagiu: false, motivo: null })).toEqual({ decisao: 'ignorou', motivo: null });
  });
  it('sem sugestão → sem_sugestao', () => {
    expect(classificarDecisao({ sugerida: null, escolhida: '003', interagiu: false, motivo: null })).toEqual({ decisao: 'sem_sugestao', motivo: null });
  });
  it('Manter sem motivo = recusou_sem_motivo (a ação explícita não vira omissão; motivo nunca é inventado)', () => {
    expect(classificarDecisao({ sugerida: '002', escolhida: '003', interagiu: true, motivo: '   ' })).toEqual({ decisao: 'recusou_sem_motivo', motivo: null });
  });
  it('escolhida que COBRE a sugerida (à vista quando se sugeriu 30/60) conta como aceitou', () => {
    expect(classificarDecisao({ sugerida: '002', escolhida: '999', interagiu: false, motivo: null, escolhidaCobre: true })).toEqual({ decisao: 'aceitou', motivo: null });
  });
});

describe('faixaVencido — rótulo da faixa que vai ao ledger (sem R$ nem nome)', () => {
  it('faixas pelo dia máximo', () => {
    expect(faixaVencido(1)).toBe('<=15d');
    expect(faixaVencido(15)).toBe('<=15d');
    expect(faixaVencido(16)).toBe('16-45d');
    expect(faixaVencido(45)).toBe('16-45d');
    expect(faixaVencido(46)).toBe('46-90d');
    expect(faixaVencido(90)).toBe('46-90d');
    expect(faixaVencido(91)).toBe('>90d');
  });
  it('ausente/inválido → null', () => {
    expect(faixaVencido(null)).toBeNull();
    expect(faixaVencido(0)).toBeNull();
    expect(faixaVencido(Number.NaN)).toBeNull();
  });
});

describe('paridade dos degraus com a aba Ciclo (helper espelhado — vendas não importa de financeiro)', () => {
  it('DEGRAUS_PRAZO_PEDIDO = DEGRAUS_PRAZO de ciclo-cliente-helpers.ts', () => {
    const fonte = readFileSync('src/lib/financeiro/ciclo-cliente-helpers.ts', 'utf8');
    const m = fonte.match(/const DEGRAUS_PRAZO: readonly number\[\] = \[([^\]]+)\];/);
    expect(m, 'DEGRAUS_PRAZO não encontrado no helper do Ciclo').toBeTruthy();
    expect([...DEGRAUS_PRAZO_PEDIDO]).toEqual(m![1].split(',').map((x) => Number(x.trim())));
  });
});

describe('parseCalendarioParcela — gramática REAL do catálogo Omie da Oben (QA pós-Publish #3473, 2026-11-01)', () => {
  it('"Para N dia(s)" → [N]; lista nua "30/60/90" → calendário; "A Vista/30/60" → [0, 30, 60]', () => {
    expect(parseCalendarioParcela('Para 30 dias')).toEqual([30]);
    expect(parseCalendarioParcela('Para 1 dia')).toEqual([1]);
    expect(parseCalendarioParcela('30/60/90')).toEqual([30, 60, 90]);
    expect(parseCalendarioParcela('28/42/56/72/87')).toEqual([28, 42, 56, 72, 87]);
    expect(parseCalendarioParcela('A Vista/30/60')).toEqual([0, 30, 60]);
    expect(parseCalendarioParcela('A Vista/28')).toEqual([0, 28]);
  });
  it('segue ilegível por desenho: número nu sozinho, "N Parcelas", "(C)", "Informar…", "A Vista/1/1", "30/30"', () => {
    expect(parseCalendarioParcela('30')).toBeNull();
    expect(parseCalendarioParcela('36 Parcelas')).toBeNull();
    expect(parseCalendarioParcela('1 Parcela')).toBeNull();
    expect(parseCalendarioParcela('Para 30 dias (C)')).toBeNull();
    expect(parseCalendarioParcela('30/60/90 (C)')).toBeNull();
    expect(parseCalendarioParcela('Informar o número de parcelas')).toBeNull();
    expect(parseCalendarioParcela('A Vista/1/1')).toBeNull();
    expect(parseCalendarioParcela('30/30')).toBeNull();
    expect(parseCalendarioParcela('A Vista/0/30')).toBeNull();
  });
  it('com as formas REAIS da Oben, 30/60/90 vencido sugere 30/60 (um degrau), e "A Vista/30/60" não é à vista', () => {
    const formas = [
      { codigo: '003', descricao: '30/60/90' },
      { codigo: '002', descricao: '30/60' },
      { codigo: '001', descricao: 'Para 30 dias' },
      { codigo: '999', descricao: 'A Vista' },
      { codigo: 'AV2', descricao: 'A Vista/30/60' },
    ];
    const s = sugerirParcela({ formas, parcelaAtual: '003', vencido: 4114, diasVencidoMax: 4 });
    expect(s).toMatchObject({ tipo: 'degrau', prazoAtual: 90, prazoSugerido: 60, motivo: 'degrau' });
    expect(s.tipo === 'degrau' && s.sugerida.codigo).toBe('002');
    // "A Vista/30/60" é calendário (prazo 60), não à vista: "Para 30 dias" NÃO o domina (no dia 0 já
    // há 1/3 recebido) e "30/60" estoura o degrau 56 → o desenho cai no fallback à vista (código real).
    const av2 = sugerirParcela({ formas, parcelaAtual: 'AV2', vencido: 4114, diasVencidoMax: 4 });
    expect(av2).toMatchObject({ tipo: 'degrau', prazoAtual: 60, prazoSugerido: 0, motivo: 'degrau' });
    expect(av2.tipo === 'degrau' && av2.sugerida.codigo).toBe('999');
  });
  it('condição mista como CANDIDATA (Codex P2): "A Vista/30/60" → "A Vista/30" quando existe; com 61 d vencido só à vista integral serve', () => {
    const formas = [
      { codigo: 'AV2', descricao: 'A Vista/30/60' },
      { codigo: 'AV1', descricao: 'A Vista/30' },
      { codigo: '001', descricao: 'Para 30 dias' },
    ];
    const s = sugerirParcela({ formas, parcelaAtual: 'AV2', vencido: 500, diasVencidoMax: 10 });
    expect(s).toMatchObject({ tipo: 'degrau', prazoAtual: 60, prazoSugerido: 30, motivo: 'degrau' });
    expect(s.tipo === 'degrau' && s.sugerida.codigo).toBe('AV1');
    // "A Vista/30" NÃO substitui o à vista integral exigido acima de 60 dias vencidos.
    expect(sugerirParcela({ formas, parcelaAtual: 'AV2', vencido: 500, diasVencidoMax: 61 })).toEqual({ tipo: 'nenhuma', motivoSistema: 'sem_forma_menor' });
  });
});
