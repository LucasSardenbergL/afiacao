import { describe, it, expect } from 'vitest';
import { mesesFechados, razaoYTD, fatorTendenciaYTD, derivarLinhas, projetarDRE, LINHAS_INPUT, seedOrcamento, type MesDRE } from '../orcamento-forecast-helpers';

describe('mesesFechados', () => {
  it('ano corrente exclui o mês corrente e futuros', () => { expect(mesesFechados(2026, new Date('2026-05-15'))).toEqual([1,2,3,4]); });
  it('ano passado = 12', () => { expect(mesesFechados(2025, new Date('2026-05-15'))).toHaveLength(12); });
  it('ano futuro = []', () => { expect(mesesFechados(2027, new Date('2026-05-15'))).toEqual([]); });
});
describe('razaoYTD', () => {
  it('Σnum/Σden', () => { expect(razaoYTD([10,20],[100,100])).toBeCloseTo(0.15,6); });
  it('denominador <=0 → null', () => { expect(razaoYTD([10],[0])).toBeNull(); expect(razaoYTD([10],[-5])).toBeNull(); });
  it('vazio → null', () => { expect(razaoYTD([],[])).toBeNull(); });
});
describe('fatorTendenciaYTD', () => {
  it('Σreceita atual / ano-1 (mesmos meses), cap [0.5,2.0]', () => {
    expect(fatorTendenciaYTD([{mes:1,receita_bruta:110},{mes:2,receita_bruta:130}],[{mes:1,receita_bruta:100},{mes:2,receita_bruta:100}],[1,2])).toBeCloseTo(1.2,6);
  });
  it('cap superior 2.0', () => { expect(fatorTendenciaYTD([{mes:1,receita_bruta:500}],[{mes:1,receita_bruta:100}],[1])).toBe(2.0); });
  it('base ano-1 <=0 → null', () => { expect(fatorTendenciaYTD([{mes:1,receita_bruta:100}],[],[1])).toBeNull(); });
});
describe('derivarLinhas', () => {
  it('fórmulas e sinais (FinDRE)', () => {
    const d = derivarLinhas({ receita_bruta:1000, deducoes:100, cmv:400, despesas_operacionais:50, despesas_administrativas:30, despesas_comerciais:20, receitas_financeiras:10, despesas_financeiras:5, outras_receitas:0, outras_despesas:0, impostos:40 });
    expect(d.receita_liquida).toBe(900);
    expect(d.lucro_bruto).toBe(500);
    expect(d.resultado_operacional).toBe(405); // 500 -50 -30 -20 +10 -5 (financeiras no operacional, = DRE v2)
    expect(d.resultado_antes_impostos).toBe(405); // 405 + 0 - 0 (só outras)
    expect(d.resultado_liquido).toBe(365); // 405 - 40
  });
  it('campos omitidos = 0, sem NaN', () => {
    const d = derivarLinhas({ receita_bruta:500 });
    expect(d.receita_liquida).toBe(500); expect(Number.isNaN(d.resultado_liquido)).toBe(false); expect(d.resultado_liquido).toBe(500);
  });
});

// ─── Task 2: projetarDRE (pipeline ordenado) ───────────────────────────────
// orçado: por padrão AUSENTE (não zero). orcUniforme preenche só as linhas passadas.
const orcUniforme = (vals: Partial<Record<string,number>>) => { const o: Partial<Record<string, (number|null)[]>> = {}; for (const k of Object.keys(vals)) o[k as never] = Array(12).fill(vals[k]); return o; };

it('0 meses fechados → sem forecast, forecast_restante=0, sem NaN', () => {
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-01-10'), dreAtual:[], dreAnoAnterior:[], orcado:orcUniforme({receita_bruta:100}) });
  expect(r.meses_fechados).toBe(0);
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.metodo).toBe('sem_forecast'); expect(rb.forecast_restante).toBe(0); expect(Number.isFinite(rb.landing)).toBe(true);
});

it('sazonal ajustado É USADO e deduções/cmv usam a base FORECASTED (não histórica)', () => {
  // hoje fev → fechado jan. atual jan receita 120; ano-1 jan-dez receita 100/mês.
  // fator = 120/100 = 1.2 → forecast receita de cada mês restante = 100(ano-1) × 1.2 = 120.
  // deducoes jan=12 → razão 12/120=0.10 → forecast deducoes mês = 0.10×120=12.
  // cmv jan=48 → receita_liquida jan=108 → razão 48/108=0.4444 → forecast cmv mês=0.4444×(120-12)=48.
  const anoAnt = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100, deducoes:10, cmv:40}));
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-02-10'), dreAtual:[{mes:1,receita_bruta:120,deducoes:12,cmv:48}], dreAnoAnterior:anoAnt, orcado:{} });
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.metodo).toBe('sazonal_ajustado');
  expect(rb.forecast_restante).toBeCloseTo(120*11, 0); // 11 meses restantes (fev-dez) × 120
  const ded = r.linhas.find(l=>l.dre_linha==='deducoes')!;
  expect(ded.forecast_restante).toBeCloseTo(12*11, 0); // prova driver sobre receita FORECASTED (120), não histórica
  const cmv = r.linhas.find(l=>l.dre_linha==='cmv')!;
  expect(cmv.forecast_restante).toBeCloseTo(48*11, 0); // prova cmv sobre receita_liquida FORECASTED
});

it('imposto razão-YTD ≠ média mensal (números divergentes)', () => {
  // fechados jan(imp 0, rec 100), fev(imp 60, rec 200), mar(imp 0, rec 100). hoje abr.
  // média mensal imposto = 20/mês × 9 = 180. razão YTD = 60/400=0.15; receita run-rate=400/3≈133.3/mês ×9=1200; imposto=0.15×1200=180?
  // → escolher números que divirjam: rec jan100/fev100/mar100 (run-rate=100), imp 0/0/45 → razão=45/300=0.15 → forecast=0.15×100×9=135; média mensal=15×9=135 (igual).
  // Pra divergir: rec 100/100/400 (run-rate=200/mês), imp 0/0/60 → razão=60/600=0.10 → 0.10×200×9=180; média mensal imposto=20×9=180 (ainda igual pois receita média ∝).
  // Divergência real: receita NÃO constante no forecast. Use sazonal: ano-1 dá receita restante alta enquanto imposto YTD baixo.
  const anoAnt = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:300}));
  const dre = [{mes:1,receita_bruta:100,impostos:5},{mes:2,receita_bruta:100,impostos:5},{mes:3,receita_bruta:100,impostos:5}]; // razão=15/300=0.05
  const r = projetarDRE({ company:'colacor', ano:2026, hoje:new Date('2026-04-10'), dreAtual:dre, dreAnoAnterior:anoAnt, orcado:{} });
  const imp = r.linhas.find(l=>l.dre_linha==='impostos')!;
  expect(imp.metodo).toBe('razao_ytd_imposto');
  // fator tendência=300/(3×300? não, mesmos meses fechados jan-mar ano-1=900) → 300/900=0.333 → cap 0.5 → receita FC mês=300×0.5=150
  // imposto FC = 0.05 × 150 × 9 = 67.5  (média mensal seria 5×9=45 → DIVERGE)
  expect(imp.forecast_restante).toBeCloseTo(0.05*150*9, 0);
  expect(imp.forecast_restante).not.toBeCloseTo(5*9, 0);
});

it('mês corrente PARCIAL não entra na base nem no landing por realizado', () => {
  // hoje maio. fechados jan-abr receita 100/mês. maio parcial ENORME (9999) presente em dreAtual.
  const dre = [1,2,3,4].map(m=>({mes:m, receita_bruta:100})).concat([{mes:5, receita_bruta:9999}]);
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-05-20'), dreAtual:dre, dreAnoAnterior:[], orcado:{} });
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.realizado_fechado).toBe(400); // só jan-abr; maio parcial NÃO entra
  expect(rb.forecast_restante).toBeCloseTo(100*8,0); // run-rate 100 × 8 (mai-dez)
});

it('variância sign-aware — parametrizado, nenhuma invertida', () => {
  // landing > orcado em TODAS. receita acima=favorável; custo/dedução/imposto acima=desfavorável.
  // monta dreAtual com 12 meses fechados (ano passado) p/ landing=realizado; orçado menor.
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100, deducoes:10, cmv:40, despesas_operacionais:5, despesas_administrativas:5, despesas_comerciais:5, despesas_financeiras:2, receitas_financeiras:3, outras_receitas:1, outras_despesas:1, impostos:8 }));
  const orc: Partial<Record<string,(number|null)[]>> = {}; for (const k of LINHAS_INPUT) orc[k] = Array(12).fill(1); // orçado baixo → landing>orçado
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:orc });
  const fav = (l:string)=> r.linhas.find(x=>x.dre_linha===l)!.favoravel;
  expect(fav('receita_bruta')).toBe(true); expect(fav('receitas_financeiras')).toBe(true); expect(fav('outras_receitas')).toBe(true);
  expect(fav('deducoes')).toBe(false); expect(fav('cmv')).toBe(false); expect(fav('despesas_financeiras')).toBe(false); expect(fav('impostos')).toBe(false);
  expect(fav('resultado_liquido')).toBe(true); // derivada de resultado acima → favorável
});

it('orçado AUSENTE → variancia null (não 0)', () => {
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100}));
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:{} }); // nada orçado
  const rb = r.linhas.find(l=>l.dre_linha==='receita_bruta')!;
  expect(rb.orcado_ano).toBeNull(); expect(rb.variancia).toBeNull(); expect(rb.fura_meta).toBe(false);
});

it('fura_meta com orcado<=0 usa só piso', () => {
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, outras_despesas:500})); // landing=6000
  const orc = { outras_despesas: Array(12).fill(0) }; // orçado 0
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:orc, pisoFuraMeta:5000 });
  const od = r.linhas.find(l=>l.dre_linha==='outras_despesas')!;
  expect(od.orcado_ano).toBe(0); expect(od.fura_meta).toBe(true); // |6000|>5000 piso; sem divisão por 0
});

it('denominador de driver <=0 → run-rate + flag, sem NaN/Infinity', () => {
  // receita_bruta fechada = 0 (mas há deducoes) → razão deducoes/receita = null → run-rate
  const dre = [{mes:1,receita_bruta:0,deducoes:10},{mes:2,receita_bruta:0,deducoes:10},{mes:3,receita_bruta:0,deducoes:10}];
  const r = projetarDRE({ company:'oben', ano:2026, hoje:new Date('2026-04-10'), dreAtual:dre, dreAnoAnterior:[], orcado:{} });
  const ded = r.linhas.find(l=>l.dre_linha==='deducoes')!;
  expect(ded.flags).toContain('denominador_zero');
  expect(Number.isFinite(ded.forecast_restante)).toBe(true);
  expect(ded.forecast_restante).toBeCloseTo(10*9,0); // run-rate 10/mês × 9
});

it('derivadas: landing E orcado_ano calculados das 11 linhas (não null)', () => {
  const dre = Array.from({length:12},(_,i)=>({mes:i+1, receita_bruta:100, deducoes:10, cmv:40, impostos:8 }));
  const orc: Partial<Record<string,(number|null)[]>> = {}; for (const k of LINHAS_INPUT) orc[k]=Array(12).fill(k==='receita_bruta'?90: k==='deducoes'?9: k==='cmv'?36: k==='impostos'?7:0);
  const r = projetarDRE({ company:'oben', ano:2025, hoje:new Date('2026-05-10'), dreAtual:dre, dreAnoAnterior:[], orcado:orc });
  const rl = r.linhas.find(l=>l.dre_linha==='resultado_liquido')!;
  expect(rl.landing).toBeCloseTo(12*(100-10-40-8),0); // 42×12=504
  expect(rl.orcado_ano).toBeCloseTo(12*(90-9-36-7),0); // 38×12=456 (NÃO null)
  expect(rl.variancia).toBeCloseTo(504-456,0);
});

describe('seedOrcamento', () => {
  const base = (linha: string, vals: number[]): MesDRE[] => vals.map((v, i) => ({ mes: i + 1, [linha]: v }));
  const linhaSeed = (seed: ReturnType<typeof seedOrcamento>, l: string) => seed.filter(s => s.dre_linha === l);

  it('amostra curta (<3 meses com valor; zero NÃO conta) → null + flag', () => {
    const seed = seedOrcamento({ dreBase: base('receita_bruta', [100, 100, 0,0,0,0,0,0,0,0,0,0]), crescimentoPerc: 10 });
    const rb = linhaSeed(seed, 'receita_bruta');
    expect(rb).toHaveLength(12);
    expect(rb.every(s => s.valor_sugerido === null && s.flag === 'amostra_curta_sem_sugestao')).toBe(true);
  });

  it('bordas sem NaN: vazio / 1 valor / todos zero → null; 12 iguais → finito sem winsorizado', () => {
    expect(linhaSeed(seedOrcamento({ dreBase: [], crescimentoPerc: 10 }), 'cmv').every(s => s.valor_sugerido === null)).toBe(true);
    expect(linhaSeed(seedOrcamento({ dreBase: base('cmv', [500,0,0,0,0,0,0,0,0,0,0,0]), crescimentoPerc: 10 }), 'cmv').every(s => s.valor_sugerido === null)).toBe(true);
    expect(linhaSeed(seedOrcamento({ dreBase: base('cmv', Array(12).fill(0)), crescimentoPerc: 10 }), 'cmv').every(s => s.valor_sugerido === null)).toBe(true);
    const iguais = linhaSeed(seedOrcamento({ dreBase: base('cmv', Array(12).fill(100)), crescimentoPerc: 0 }), 'cmv');
    expect(iguais.every(s => Number.isFinite(s.valor_sugerido!) && s.flag === undefined)).toBe(true);
  });

  it('crescimento mês a mês (12 iguais)', () => {
    const da = linhaSeed(seedOrcamento({ dreBase: base('despesas_administrativas', Array(12).fill(100)), crescimentoPerc: 10 }), 'despesas_administrativas');
    expect(da.every(s => s.valor_sugerido === 110)).toBe(true);
  });

  it('winsorize por múltiplo da mediana: cap EXATO = mediana×fator (g=0)', () => {
    const vals = Array(12).fill(100); vals[5] = 10000;
    const dc = linhaSeed(seedOrcamento({ dreBase: base('despesas_comerciais', vals), crescimentoPerc: 0, fatorOutlier: 3 }), 'despesas_comerciais');
    const mesOutlier = dc.find(s => s.mes === 6)!;
    expect(mesOutlier.flag).toBe('winsorizado');
    expect(mesOutlier.valor_sugerido).toBe(300);
    expect(dc.find(s => s.mes === 1)!.valor_sugerido).toBe(100);
  });

  it('mês ausente → mediaCap (com winsorize) + flag mes_ausente_media', () => {
    const dreBase = [100,100,100,100,100,10000].map((v,i)=>({ mes:i+1, cmv:v }));
    const cmv = linhaSeed(seedOrcamento({ dreBase, crescimentoPerc: 0, fatorOutlier: 3 }), 'cmv');
    expect(cmv).toHaveLength(12);
    const ausente = cmv.find(s => s.mes === 11)!;
    expect(ausente.flag).toBe('mes_ausente_media');
    expect(ausente.valor_sugerido!).toBeCloseTo(133.33, 2);
  });

  it('round2 + crescimento negativo (sem inverter sinal)', () => {
    const dc = linhaSeed(seedOrcamento({ dreBase: base('despesas_operacionais', Array(12).fill(1000)), crescimentoPerc: -10 }), 'despesas_operacionais');
    expect(dc.every(s => s.valor_sugerido === 900)).toBe(true);
  });

  it('materialidade: centavos residuais NÃO contam como amostra (não arrastam a mediana)', () => {
    // [100000, 0.01, 0.01] → mat=1% de 100000=1000 → só 1 mês material → amostra curta, sem sugestão
    const seed = seedOrcamento({ dreBase: base('receita_bruta', [100000, 0.01, 0.01, 0,0,0,0,0,0,0,0,0]), crescimentoPerc: 0 });
    const rb = linhaSeed(seed, 'receita_bruta');
    expect(rb.every(s => s.valor_sugerido === null && s.flag === 'amostra_curta_sem_sugestao')).toBe(true);
  });

  it('crescimento < -100 → orçamento não-negativo (clamp em -100 → 0)', () => {
    const dc = linhaSeed(seedOrcamento({ dreBase: base('cmv', Array(12).fill(100)), crescimentoPerc: -150 }), 'cmv');
    expect(dc.every(s => s.valor_sugerido === 0)).toBe(true);
  });
});
