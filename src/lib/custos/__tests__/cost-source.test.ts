import { describe, it, expect } from 'vitest';
import { resolverCustoConfiavel, estimarCustoParaRanking, derivarMargensCandidato, resolverCustoCockpit, type CostRow } from '../cost-source';

const row = (o: Partial<CostRow>): CostRow => ({ cost_price: null, cost_final: null, cost_source: null, cost_confidence: null, ...o });

describe('resolverCustoConfiavel', () => {
  it('PRODUCT_COST com cost_final>0 → cost_final', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: 12.5 }))).toBe(12.5);
  });
  it('CMC com cost_final>0 → cost_final', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 8 }))).toBe(8);
  });
  it('CMC com cost_final=0 mas cost_price>0 → cost_price (os 14 do syncInventory)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 0, cost_price: 9.9 }))).toBe(9.9);
  });
  it('PRODUCT_COST com cost_final inválido NÃO cai p/ cost_price → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: 0, cost_price: 9.9 }))).toBeNull();
  });
  it('FAMILY_MARGIN_PROXY → null (não fabrica margem)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 50 }))).toBeNull();
  });
  it('DEFAULT_PROXY → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'DEFAULT_PROXY', cost_final: 50 }))).toBeNull();
  });
  it('UNKNOWN / source null / row null → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'UNKNOWN', cost_final: 50 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: null, cost_final: 50 }))).toBeNull();
    expect(resolverCustoConfiavel(null)).toBeNull();
    expect(resolverCustoConfiavel(undefined)).toBeNull();
  });
  it('falsificação: cost_final negativo/NaN/Infinity → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: -5 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: NaN }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'PRODUCT_COST', cost_final: Infinity }))).toBeNull();
  });
  it('falsificação CMC: cost_final E cost_price inválidos → null', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: 0, cost_price: 0 }))).toBeNull();
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC', cost_final: NaN, cost_price: -1 }))).toBeNull();
  });
  it('normaliza espaço/caixa do backfill', () => {
    expect(resolverCustoConfiavel(row({ cost_source: '  product_cost  ', cost_final: 7 }))).toBe(7);
  });
});

describe('estimarCustoParaRanking', () => {
  it('custo real presente → custo real', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'PRODUCT_COST', cost_final: 30 }), 100)).toBe(30);
  });
  it('sem real, proxy cost_final válido (<price) → proxy cost_final', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 60 }), 100)).toBe(60);
    expect(estimarCustoParaRanking(row({ cost_source: 'DEFAULT_PROXY', cost_final: 75 }), 100)).toBe(75);
  });
  it('proxy cost_final ≥ price (margem estimada ≤0) → null', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'DEFAULT_PROXY', cost_final: 120 }), 100)).toBeNull();
  });
  it('UNKNOWN / sem row / proxy sem cost_final → null', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'UNKNOWN', cost_final: 50 }), 100)).toBeNull();
    expect(estimarCustoParaRanking(null, 100)).toBeNull();
    expect(estimarCustoParaRanking(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: null }), 100)).toBeNull();
  });
});

describe('derivarMargensCandidato', () => {
  it('custo real → exibida e ranking iguais (margem real)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'PRODUCT_COST', cost_final: 30 }), 100))
      .toEqual({ custoConfiavel: 30, custoRanking: 30, margemExibida: 70, margemRanking: 70 });
  });
  it('proxy → exibida null, ranking via estimativa (não fabrica margem exibida)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 60 }), 100))
      .toEqual({ custoConfiavel: null, custoRanking: 60, margemExibida: null, margemRanking: 40 });
  });
  it('UNKNOWN/sem sinal → tudo null (EIP será neutralizado pelo motor)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'UNKNOWN' }), 100))
      .toEqual({ custoConfiavel: null, custoRanking: null, margemExibida: null, margemRanking: null });
  });
});

// CMC_MARGEM_ATIPICA é CMC REAL (margem fora da banda comercial: prejuízo/baixa/alta), de confiança
// rebaixada, mas custo REAL — entra em COST_SOURCES_REAIS e PROPAGA como real (decisão do founder:
// "propagar como real"). O ponto: a margem negativa fica VISÍVEL (não mascarada por proxy).
describe('CMC_MARGEM_ATIPICA — custo real atípico propaga como real (margem negativa observável)', () => {
  it('resolverCustoConfiavel retorna o cost_final real (não null como proxy)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC_MARGEM_ATIPICA', cost_final: 120 }))).toBe(120);
  });
  it('fallback p/ cost_price quando cost_final inválido (real CMC-derivado carrega cost_price)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC_MARGEM_ATIPICA', cost_final: 0, cost_price: 120 }))).toBe(120);
  });
  it('estimarCustoParaRanking usa o custo real (o SKU ranqueia pela margem real, inclusive ruim)', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'CMC_MARGEM_ATIPICA', cost_final: 120 }), 100)).toBe(120);
  });
  it('derivarMargensCandidato EXPÕE a margem negativa real (não a esconde atrás de um proxy)', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'CMC_MARGEM_ATIPICA', cost_final: 120 }), 100))
      .toEqual({ custoConfiavel: 120, custoRanking: 120, margemExibida: -20, margemRanking: -20 });
  });
  it('falsificação: cost_final E cost_price inválidos → null (não fabrica custo)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC_MARGEM_ATIPICA', cost_final: 0, cost_price: 0 }))).toBeNull();
  });
});

// CMC_UNIDADE_SUSPEITA é DESCASAMENTO DE UNIDADE (cmc por m² vs price noutra unidade). O cost_final é
// PROXY de família — NÃO é custo real comparável: fica FORA de COST_SOURCES_REAIS (margem exibida null),
// mas ENTRA como proxy p/ ranking (decisão D3 + achado do Codex: estimarCustoParaRanking retornava null
// p/ a fonte nova). Diferente do CMC_MARGEM_ATIPICA, que é real e propaga.
describe('CMC_UNIDADE_SUSPEITA — descasamento de unidade: proxy p/ ranking, nunca margem exibida', () => {
  it('resolverCustoConfiavel → null (cmc não comparável ao price; não é custo real de margem)', () => {
    expect(resolverCustoConfiavel(row({ cost_source: 'CMC_UNIDADE_SUSPEITA', cost_final: 60 }))).toBeNull();
  });
  it('estimarCustoParaRanking usa o cost_final proxy (<price) p/ ranking', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'CMC_UNIDADE_SUSPEITA', cost_final: 60 }), 100)).toBe(60);
  });
  it('derivarMargensCandidato: margem exibida null (não fabrica), ranking via proxy', () => {
    expect(derivarMargensCandidato(row({ cost_source: 'CMC_UNIDADE_SUSPEITA', cost_final: 60 }), 100))
      .toEqual({ custoConfiavel: null, custoRanking: 60, margemExibida: null, margemRanking: 40 });
  });
  it('proxy ≥ price (margem estimada ≤0) → ranking null (sanity bound do proxy vale aqui também)', () => {
    expect(estimarCustoParaRanking(row({ cost_source: 'CMC_UNIDADE_SUSPEITA', cost_final: 120 }), 100)).toBeNull();
  });
});

// resolverCustoCockpit é a régua do COCKPIT de valor (A3), DIFERENTE de resolverCustoConfiavel: o cockpit
// COMPUTA-E-DEGRADA (#1003) — exibe a margem mesmo de proxy, mas marca baixaConfianca p/ rebaixar o nível de
// confiança (custo_baixa_confianca_pct); recommend/audit NULIFICAM proxy. Split intencional, NÃO unificar.
// baixaConfianca = fallback legado (cost_price) OU source não-real OU cost_confidence<0.7. A cláusula de SOURCE
// blinda o invariante latente: um proxy carimbado com conf>=0.7 pelo motor NÃO vira margem firme silenciosa.
describe('resolverCustoCockpit — régua do cockpit (computa-e-degrada, NÃO nulifica proxy)', () => {
  it('CMC conf alta + cost_final>0 → custo firme (não baixa)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC', cost_final: 8, cost_confidence: 0.85 })))
      .toEqual({ custo: 8, baixaConfianca: false, legadoFallback: false });
  });
  it('conf no limite 0.7 → firme (>=)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC', cost_final: 8, cost_confidence: 0.7 })).baixaConfianca).toBe(false);
  });
  it('proxy conf 0.5 → custo EXIBIDO mas baixa confiança (não nulifica como recommend)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 50, cost_confidence: 0.5 })))
      .toEqual({ custo: 50, baixaConfianca: true, legadoFallback: false });
  });
  // O CORAÇÃO da B-mínima — o invariante latente. SEM a cláusula de source, isto seria baixaConfianca:false (BUG).
  it('INVARIANTE: proxy com conf>=0.7 (motor carimbou errado) → AINDA baixa confiança (cláusula de source)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'FAMILY_MARGIN_PROXY', cost_final: 50, cost_confidence: 0.9 })))
      .toEqual({ custo: 50, baixaConfianca: true, legadoFallback: false });
  });
  it('source desconhecida com conf alta → baixa (fonte nova não vira firme sem se declarar real)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'XYZ_NOVA', cost_final: 50, cost_confidence: 0.95 })).baixaConfianca).toBe(true);
  });
  it('CMC_MARGEM_ATIPICA (real) conf 0.6 → custo real exibido, mas baixa por conf<0.7', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC_MARGEM_ATIPICA', cost_final: 120, cost_confidence: 0.6 })))
      .toEqual({ custo: 120, baixaConfianca: true, legadoFallback: false });
  });
  it('CMC_MARGEM_ATIPICA real com conf alta → firme (source-aware NÃO rebaixa custo real)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC_MARGEM_ATIPICA', cost_final: 120, cost_confidence: 0.9 })).baixaConfianca).toBe(false);
  });
  it('fallback legado cost_price (cost_final inválido) → SEMPRE baixa, mesmo source real + conf alta', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC', cost_final: 0, cost_price: 9.9, cost_confidence: 0.85 })))
      .toEqual({ custo: 9.9, baixaConfianca: true, legadoFallback: true });
  });
  it('PRODUCT_COST conf alta → firme (invariante-IRMÃO: B-mínima confia em PRODUCT_COST; cobertura fica no motor/sentinela)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'PRODUCT_COST', cost_final: 30, cost_confidence: 0.95 })).baixaConfianca).toBe(false);
  });
  it('cost_confidence null em source real válido → baixa (política conservadora: sem score, não vouchar)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC', cost_final: 8, cost_confidence: null })).baixaConfianca).toBe(true);
  });
  it('sem custo: cost_final e cost_price inválidos → custo null (cm null no combo)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC', cost_final: 0, cost_price: 0, cost_confidence: 0.85 })))
      .toEqual({ custo: null, baixaConfianca: false, legadoFallback: false });
  });
  it('falsificação: cost_final NaN → fallback p/ cost_price; cost_final Infinity + cost_price inválido → null', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'CMC', cost_final: NaN, cost_price: 7, cost_confidence: 0.8 })).custo).toBe(7);
    expect(resolverCustoCockpit(row({ cost_source: 'CMC', cost_final: Infinity, cost_price: -1, cost_confidence: 0.8 })).custo).toBeNull();
  });
  it('normaliza espaço/caixa do source (proxy disfarçado não escapa da cláusula)', () => {
    expect(resolverCustoCockpit(row({ cost_source: '  family_margin_proxy  ', cost_final: 50, cost_confidence: 0.9 })).baixaConfianca).toBe(true);
  });
  it('source REAL normalizado (espaço nas pontas/caixa) com conf alta → firme (simetria com o proxy disfarçado)', () => {
    expect(resolverCustoCockpit(row({ cost_source: '  cmc  ', cost_final: 8, cost_confidence: 0.85 })).baixaConfianca).toBe(false);
    expect(resolverCustoCockpit(row({ cost_source: 'Cmc_Margem_Atipica', cost_final: 120, cost_confidence: 0.9 })).baixaConfianca).toBe(false);
  });
  it('source com espaço INTERNO (malformado, enum-like ASCII) → baixa (trim não conserta; não-real, conservador)', () => {
    expect(resolverCustoCockpit(row({ cost_source: 'C M C', cost_final: 8, cost_confidence: 0.9 })).baixaConfianca).toBe(true);
  });
});
