import { describe, it, expect } from 'vitest';
import {
  faixaAging, daysBetween, addDays,
  mediaPonderada, mediana,
  calibrarCurvas, CURVA_DEFAULT,
  dataRecebimentoEsperada, aplicarCenarioCurva,
  inadimplenciaPonderada, prazoMedioPonderado,
  statusLiquidado, valorPagoEfetivo, prazoComGate, diasCoberturaProjetado,
} from '../aging-helpers';

describe('faixaAging', () => {
  it('não vencido ou vence hoje → a_vencer', () => {
    expect(faixaAging(0)).toBe('a_vencer');
    expect(faixaAging(-5)).toBe('a_vencer');
  });
  it('limites das faixas', () => {
    expect(faixaAging(1)).toBe('1-30');
    expect(faixaAging(30)).toBe('1-30');
    expect(faixaAging(31)).toBe('31-60');
    expect(faixaAging(60)).toBe('31-60');
    expect(faixaAging(61)).toBe('61-90');
    expect(faixaAging(90)).toBe('61-90');
    expect(faixaAging(91)).toBe('+90');
    expect(faixaAging(400)).toBe('+90');
  });
});

describe('daysBetween / addDays', () => {
  it('daysBetween em dias inteiros', () => {
    expect(daysBetween('2026-05-19', '2026-05-09')).toBe(10);
  });
  it('addDays soma dias (UTC)', () => {
    expect(addDays('2026-05-19', 7)).toBe('2026-05-26');
  });
});

describe('mediaPonderada', () => {
  it('pondera por peso (R$)', () => {
    expect(mediaPonderada([{ valor: 70, peso: 100000 }, { valor: 5, peso: 1000 }])).toBeCloseTo(69.36, 1);
  });
  it('peso total 0 → 0', () => {
    expect(mediaPonderada([{ valor: 10, peso: 0 }])).toBe(0);
  });
});

describe('mediana', () => {
  it('ímpar', () => { expect(mediana([5, 1, 3])).toBe(3); });
  it('par = média dos centrais', () => { expect(mediana([1, 2, 3, 4])).toBe(2.5); });
  it('vazio → 0', () => { expect(mediana([])).toBe(0); });
});

const hoje = '2026-05-19';

describe('statusLiquidado', () => {
  it('RECEBIDO/LIQUIDADO/PAGO → true', () => {
    expect(statusLiquidado('RECEBIDO')).toBe(true);
    expect(statusLiquidado('LIQUIDADO')).toBe(true);
    expect(statusLiquidado('PAGO')).toBe(true);
  });
  it('ABERTO/VENCIDO/PARCIAL/null → false', () => {
    expect(statusLiquidado('ABERTO')).toBe(false);
    expect(statusLiquidado('VENCIDO')).toBe(false);
    expect(statusLiquidado('PARCIAL')).toBe(false);
    expect(statusLiquidado(null)).toBe(false);
  });
});

describe('valorPagoEfetivo (robusto a valor_recebido NULL/0)', () => {
  it('usa valor_recebido quando > 0', () => {
    expect(valorPagoEfetivo({ valor_recebido: 80, valor_documento: 100, saldo: 0 })).toBe(80);
  });
  it('fallback valor_documento − saldo quando recebido 0', () => {
    expect(valorPagoEfetivo({ valor_recebido: 0, valor_documento: 100, saldo: 30 })).toBe(70);
  });
  it('fallback face quando recebido 0 e saldo cheio (sem info de valor)', () => {
    expect(valorPagoEfetivo({ valor_recebido: 0, valor_documento: 100, saldo: 100 })).toBe(100);
  });
});

describe('prazoComGate (PMR/PMP por cobertura)', () => {
  it('cobertura >= min e valor presente → valor', () => {
    expect(prazoComGate(30, 1.0)).toBe(30);
    expect(prazoComGate(30, 0.4)).toBe(30);
  });
  it('cobertura < min → null (amostra não-representativa)', () => {
    expect(prazoComGate(30, 0.1)).toBe(null);
  });
  it('valor null/undefined → null', () => {
    expect(prazoComGate(null, 1.0)).toBe(null);
    expect(prazoComGate(undefined, 1.0)).toBe(null);
  });
  it('cobertura null/undefined → null', () => {
    expect(prazoComGate(30, null)).toBe(null);
    expect(prazoComGate(30, undefined)).toBe(null);
  });
});

describe('diasCoberturaProjetado (caixa operacional projetado)', () => {
  it('saldo / saída diária média do horizonte', () => {
    // 91000 de saída em 13 sem (91 dias) → 1000/dia; saldo 30000 → 30 dias
    expect(diasCoberturaProjetado(30000, 91000, 13)).toBeCloseTo(30, 5);
  });
  it('saldo <= 0 → 0 (crítico)', () => {
    expect(diasCoberturaProjetado(0, 91000, 13)).toBe(0);
    expect(diasCoberturaProjetado(-500, 91000, 13)).toBe(0);
  });
  it('sem base de saída → null (não 999/infinito)', () => {
    expect(diasCoberturaProjetado(30000, 0, 13)).toBe(null);
  });
  it('horizon 0 não divide por zero (clamp do divisor em 1)', () => {
    // saidaDiaria = 7000 / max(1, 0) = 7000; dias = 7000/7000 = 1 (finito, sem NaN/Infinity)
    const r = diasCoberturaProjetado(7000, 7000, 0);
    expect(r).toBe(1);
    expect(Number.isFinite(r as number)).toBe(true);
  });
  // Mutation-check (auto-ensino 2026-06-06): o teste de "sem base" usa saidas=0 exato, que
  // `> 0` também pega — o PISO 0.01 (saída diária minúscula mas não-zero) nunca era exercitado.
  // Sem o piso, saldo/0.0055 dá milhões de dias e DESLIGA o alerta "caixa cobre só X dias".
  it('saída diária abaixo do piso (entre 0 e 0.01/dia) → null, não cobertura "quase infinita"', () => {
    // 0.5 em 13 sem (91 dias) → ~0.0055/dia < piso 0.01 → null (guard money-path explícito)
    expect(diasCoberturaProjetado(30000, 0.5, 13)).toBe(null);
  });
});

describe('calibrarCurvas (por exposição, baixa derivada + status)', () => {
  it('aberto não-pago na faixa puxa a taxa pra baixo (sem viés)', () => {
    const titulos = [
      // liquidado COM baixa derivada → bucketiza por atraso no pagamento (35d → 31-60)
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: '2026-04-24', status_titulo: 'RECEBIDO' },
      // aberto (45d hoje → 31-60)
      { valor_documento: 100000, valor_recebido: 0, saldo: 100000, data_vencimento: '2026-04-04', data_baixa_derivada: null, status_titulo: 'VENCIDO' },
    ];
    // gates baixos (minTitulos/minVolume/minLiq=1) pra exercitar o cálculo; cobertura = 1/1 = 1.0
    const curvas = calibrarCurvas(titulos, hoje, 1, 1, 1);
    expect(curvas['31-60'].confianca).toBe('alta');
    expect(curvas['31-60'].taxa_recebimento).toBeCloseTo(0.5, 5);
    expect(curvas['31-60'].exposicao).toBe(200000);
    expect(curvas['31-60'].pago).toBe(100000);
    expect(curvas['31-60'].aberto).toBe(100000);
  });

  it('liquidado por STATUS sem valor_recebido ainda conta como pago (valorPagoEfetivo)', () => {
    // 5 títulos (concentração 0.2 ≤ 0.6) com status liquidado mas valor_recebido 0 e
    // saldo 0 → pago = valor_documento (face) via fallback, NÃO pago 0
    const titulos = Array.from({ length: 5 }, () => ({
      valor_documento: 100000, valor_recebido: 0, saldo: 0,
      data_vencimento: '2026-03-20', data_baixa_derivada: '2026-04-24', status_titulo: 'LIQUIDADO',
    }));
    const curvas = calibrarCurvas(titulos, hoje, 1, 1, 1);
    expect(curvas['31-60'].pago).toBe(500000);
    expect(curvas['31-60'].taxa_recebimento).toBeCloseTo(1, 5);
  });

  it('REGRESSÃO: faixa só com abertos não vira taxa 0 com confiança alta', () => {
    // o bug antigo: data sempre NULL → todos abertos → pago=0, mas gate passava → taxa 0 'alta'
    const titulos = Array.from({ length: 30 }, () => ({
      valor_documento: 100000, valor_recebido: 0, saldo: 100000,
      data_vencimento: '2026-04-04', data_baixa_derivada: null, status_titulo: 'VENCIDO',
    }));
    const curvas = calibrarCurvas(titulos, hoje); // gates default (20, 50k, 5, 0.4)
    expect(curvas['31-60'].confianca).toBe('baixa');
    expect(curvas['31-60'].taxa_recebimento).toBe(CURVA_DEFAULT['31-60'].taxa_recebimento);
  });

  it('GATE EMPRESA: cobertura < 40% → nenhuma faixa alta (default)', () => {
    const titulos = [
      // 1 liquidado COM data (entra na calibração de 31-60)
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: '2026-04-24', status_titulo: 'RECEBIDO' },
      // 2 liquidados SEM data → puxam a cobertura pra 1/3 = 0.33 (< 0.4)
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: null, status_titulo: 'RECEBIDO' },
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: null, status_titulo: 'LIQUIDADO' },
    ];
    // gates de faixa frouxos (1,1,1) → só a cobertura da empresa segura
    const curvas = calibrarCurvas(titulos, hoje, 1, 1, 1);
    expect(curvas['31-60'].confianca).toBe('baixa');
    expect(curvas['31-60'].taxa_recebimento).toBe(CURVA_DEFAULT['31-60'].taxa_recebimento);
  });

  // Mutation-check (auto-ensino 2026-06-06): prazoComGate testa a borda exata 0.40, mas
  // calibrarCurvas (mesma constante COBERTURA_MIN_EMPRESA) não — a mutação `>=`→`>` sobrevivia.
  // O limiar de 40% é INCLUSIVO: exatamente 40% de cobertura ainda calibra.
  it('GATE EMPRESA na BORDA: cobertura == 40% (limiar exato) ainda calibra (>=, não >)', () => {
    const titulos = [
      // 2 liquidados-COM-data na 31-60 (entram na calibração)
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: '2026-04-24', status_titulo: 'RECEBIDO' },
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: '2026-04-24', status_titulo: 'RECEBIDO' },
      // 3 liquidados-SEM-data → cobertura = 2/5 = 0.40 EXATO (só contam no denominador)
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: null, status_titulo: 'RECEBIDO' },
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: null, status_titulo: 'LIQUIDADO' },
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: null, status_titulo: 'PAGO' },
    ];
    const curvas = calibrarCurvas(titulos, hoje, 1, 1, 1); // gates de faixa frouxos → só a cobertura (0.40) decide
    expect(curvas['31-60'].confianca).toBe('alta'); // 0.40 >= 0.40 inclui o limiar
  });

  it('GATE FAIXA: com empresa calibrável, faixa sem liquidado-datado cai no default', () => {
    const titulos = [
      // 10 liquidados-com-data em a_vencer (pagos 1d antes do venc) → calibra a_vencer
      ...Array.from({ length: 10 }, () => ({
        valor_documento: 100000, valor_recebido: 100000, saldo: 0,
        data_vencimento: '2026-05-25', data_baixa_derivada: '2026-05-24', status_titulo: 'RECEBIDO',
      })),
      // 5 abertos em +90 (sem liquidado-datado nessa faixa)
      ...Array.from({ length: 5 }, () => ({
        valor_documento: 100000, valor_recebido: 0, saldo: 100000,
        data_vencimento: '2026-01-01', data_baixa_derivada: null, status_titulo: 'VENCIDO',
      })),
    ];
    // cobertura = 10/10 = 1.0 (VENCIDO não é liquidado); minTitulos 5, minVol 1, minLiq default 5
    const curvas = calibrarCurvas(titulos, hoje, 5, 1);
    expect(curvas['a_vencer'].confianca).toBe('alta');
    expect(curvas['+90'].confianca).toBe('baixa');
    expect(curvas['+90'].taxa_recebimento).toBe(CURVA_DEFAULT['+90'].taxa_recebimento);
  });

  it('liquidado sem baixa derivada é EXCLUÍDO da calibração (não entra em exposicao/pago)', () => {
    const titulos = [
      { valor_documento: 100000, valor_recebido: 100000, saldo: 0, data_vencimento: '2026-03-20', data_baixa_derivada: null, status_titulo: 'RECEBIDO' },
    ];
    const curvas = calibrarCurvas(titulos, hoje, 1, 1, 1);
    expect(curvas['31-60'].exposicao).toBe(0);
    expect(curvas['31-60'].confianca).toBe('baixa');
  });
});

describe('dataRecebimentoEsperada', () => {
  it('a_vencer: vencimento + lag', () => {
    expect(dataRecebimentoEsperada({ data_vencimento: '2026-06-01', hoje: '2026-05-19', faixa: 'a_vencer', lag_dias_faixa: 5 })).toBe('2026-06-06');
  });
  it('vencido: hoje + lag restante (lag - atraso atual)', () => {
    expect(dataRecebimentoEsperada({ data_vencimento: '2026-05-09', hoje: '2026-05-19', faixa: '1-30', lag_dias_faixa: 20 })).toBe('2026-05-29');
  });
  it('vencido além do lag esperado: usa residual default (não cai hoje)', () => {
    expect(dataRecebimentoEsperada({ data_vencimento: '2025-11-01', hoje: '2026-05-19', faixa: '+90', lag_dias_faixa: 150, lag_residual_default: 15 })).toBe('2026-06-03');
  });
});

describe('aplicarCenarioCurva (clamps)', () => {
  const base = { taxa_recebimento: 0.8, lag_dias: 70, lag_mediana: 60, exposicao: 0, pago: 0, aberto: 0, confianca: 'alta' as const };
  it('otimista: taxa sobe (perda cai), lag cai', () => {
    const r = aplicarCenarioCurva(base, '61-90', { recebimento_no_prazo_pct_delta: 10, inadimplencia_pct_delta: -50 });
    expect(r.taxa_recebimento).toBeCloseTo(0.9, 5);
    expect(r.lag_dias).toBeCloseTo(63, 5);
  });
  it('pessimista: taxa cai, lag sobe mas respeita LAG_MAX', () => {
    const r = aplicarCenarioCurva({ ...base, lag_dias: 115 }, '61-90', { recebimento_no_prazo_pct_delta: -15, inadimplencia_pct_delta: 50 });
    expect(r.taxa_recebimento).toBeCloseTo(0.7, 5);
    expect(r.lag_dias).toBe(120);
  });
  it('taxa nunca passa de 1 nem fica negativa', () => {
    const r = aplicarCenarioCurva({ ...base, taxa_recebimento: 0.95 }, 'a_vencer', { recebimento_no_prazo_pct_delta: 0, inadimplencia_pct_delta: -200 });
    expect(r.taxa_recebimento).toBe(1);
  });
});

describe('inadimplenciaPonderada', () => {
  it('média ponderada por R$ de (1 - taxa) sobre CR aberto', () => {
    const curvas = {
      'a_vencer': { taxa_recebimento: 1.0 }, '1-30': { taxa_recebimento: 0.9 },
      '31-60': { taxa_recebimento: 0.8 }, '61-90': { taxa_recebimento: 0.7 }, '+90': { taxa_recebimento: 0.5 },
    } as Record<'a_vencer'|'1-30'|'31-60'|'61-90'|'+90', { taxa_recebimento: number }>;
    const crs = [
      { saldo: 100000, faixa: 'a_vencer' as const },
      { saldo: 100000, faixa: '+90' as const },
    ];
    expect(inadimplenciaPonderada(crs, curvas)).toBeCloseTo(25, 5);
  });
});

describe('prazoMedioPonderado', () => {
  it('pondera por valor (não por contagem)', () => {
    expect(prazoMedioPonderado([
      { dias: 70, valor: 100000 }, { dias: 5, valor: 1000 },
    ])).toBeCloseTo(69.36, 1);
  });
});
