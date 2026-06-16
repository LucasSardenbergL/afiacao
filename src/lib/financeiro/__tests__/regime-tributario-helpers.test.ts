import { describe, it, expect } from 'vitest';
import { PARTILHA_SIMPLES, partilhaIndiretoFrac, impostoAnualSimples, elegibilidadeSimples } from '../regime-tributario-helpers';
import { impostoAnualPresumido, impostoAnualReal, encargoPatronal, anexoEfetivoFatorR, breakEvenMargemReal } from '../regime-tributario-helpers';
import { compararRegimes, recomendarRegime, scoreConfiancaRegime } from '../regime-tributario-helpers';

describe('PARTILHA_SIMPLES — invariante de soma', () => {
  it('todas as faixas somam 1.0 (±1e-9)', () => {
    for (const anexo of Object.keys(PARTILHA_SIMPLES) as Array<keyof typeof PARTILHA_SIMPLES>) {
      for (const faixa of PARTILHA_SIMPLES[anexo]) {
        const soma = faixa.irpj + faixa.csll + faixa.cofins + faixa.pis + faixa.cpp + faixa.icms + faixa.iss + faixa.ipi;
        expect(soma).toBeCloseTo(1, 9);
      }
    }
  });
});

describe('partilhaIndiretoFrac — fração indireta (ICMS/ISS/IPI) da alíquota efetiva, com teto de ISS', () => {
  it('anexo I (comércio), 1ª faixa: indireto = ICMS', () => {
    const r = partilhaIndiretoFrac('I', 100000, 0.04);
    expect(r).toBeCloseTo(0.04 * PARTILHA_SIMPLES.I[0].icms, 9);
  });
  it('anexo III, 5ª faixa: ISS satura em 5% e excedente vai pro federal', () => {
    const efetiva = 0.18; // > 0.1492537
    const indireto = partilhaIndiretoFrac('III', 2_000_000, efetiva);
    expect(indireto).toBeCloseTo(0.05, 9);
  });
});

describe('impostoAnualSimples', () => {
  it('decompõe DAS em federal+CPP (tira ICMS/ISS/IPI)', () => {
    const r = impostoAnualSimples({ anexo: 'I', rbt12: 100000, receitaAnual: 100000 });
    expect(r.das_total).toBeCloseTo(4000, 0);
    expect(r.icms_iss_ipi).toBeCloseTo(4000 * PARTILHA_SIMPLES.I[0].icms, 0);
    expect(r.total_federal_cpp).toBeCloseTo(r.das_total - r.icms_iss_ipi, 0);
    expect(r.aproximado).toBe(true);
  });
});

describe('elegibilidadeSimples — usa RBA (ano-calendário), não RBT12', () => {
  it('RBA ≤ 3,6M → elegivel', () => {
    expect(elegibilidadeSimples(3_000_000).status_elegibilidade).toBe('elegivel');
  });
  it('3,6M < RBA ≤ 4,8M → sublimite_excedido (ICMS/ISS fora do DAS)', () => {
    expect(elegibilidadeSimples(4_000_000).status_elegibilidade).toBe('sublimite_excedido');
  });
  it('RBA > 4,8M → inelegivel', () => {
    const r = elegibilidadeSimples(5_000_000);
    expect(r.status_elegibilidade).toBe('inelegivel');
    expect(r.motivo_inelegivel).toContain('4,8');
  });
  // Mutation-check (auto-ensino 2026-06-06): a LC 123 diz "receita SUPERIOR a" (>, não >=).
  // RBA no teto/sublimite EXATO ainda é elegível/sublimite; os testes usavam 3M/4M/5M, nunca as
  // bordas exatas → as mutações '>'->'>=' (teto e sublimite) sobreviviam.
  it('RBA EXATO no teto/sublimite ainda é elegível ("superior a", não ">=")', () => {
    expect(elegibilidadeSimples(4_800_000).status_elegibilidade).toBe('sublimite_excedido'); // 4,8M exato NÃO inelegível
    expect(elegibilidadeSimples(3_600_000).status_elegibilidade).toBe('elegivel');           // 3,6M exato NÃO sublimite
  });
});

describe('impostoAnualPresumido — anualizado, adicional por trimestre, receitas financeiras integrais', () => {
  it('soma 4 trimestres; adicional de 10% por trimestre (não teto anual)', () => {
    const r = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(r.irpj).toBeCloseTo(4 * 14000, 0);
  });
  it('sazonalidade: 1 trimestre alto gera adicional que a média esconde', () => {
    const sazonal = impostoAnualPresumido({ trimestres: [4e6, 0, 0, 0], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    const uniforme = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(sazonal.irpj).toBeGreaterThan(uniforme.irpj);
  });
  it('receitas financeiras entram integrais na base IRPJ/CSLL (não via presunção)', () => {
    const sem = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    const com = impostoAnualPresumido({ trimestres: [1e6, 1e6, 1e6, 1e6], presuncaoIrpj: 0.08, presuncaoCsll: 0.12, receitasFinanceiras: 100000, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(com.irpj + com.csll).toBeGreaterThan(sem.irpj + sem.csll);
  });
});

describe('impostoAnualReal', () => {
  it('lucro ≤ 0 → IRPJ/CSLL = 0', () => {
    const r = impostoAnualReal({ lucroAnual: -50000, lucroTrimestres: [-12500, -12500, -12500, -12500], receitaTributavel: 1e6, receitasFinanceiras: 0, creditoPct: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(r.irpj).toBe(0); expect(r.csll).toBe(0);
  });
  it('PIS/COFINS não-cumulativo 9,25% − crédito; financeiras a 4,65%', () => {
    const r = impostoAnualReal({ lucroAnual: 0, lucroTrimestres: [0, 0, 0, 0], receitaTributavel: 1e6, receitasFinanceiras: 100000, creditoPct: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(r.pis_cofins).toBeCloseTo(92500 + 4650, 0);
  });
  it('crédito reduz o PIS/COFINS', () => {
    const sem = impostoAnualReal({ lucroAnual: 0, lucroTrimestres: [0,0,0,0], receitaTributavel: 1e6, receitasFinanceiras: 0, creditoPct: 0, folhaCppAnual: 0, encargoPct: 0.20 });
    const com = impostoAnualReal({ lucroAnual: 0, lucroTrimestres: [0,0,0,0], receitaTributavel: 1e6, receitasFinanceiras: 0, creditoPct: 0.3, folhaCppAnual: 0, encargoPct: 0.20 });
    expect(com.pis_cofins).toBeLessThan(sem.pis_cofins);
  });
});

describe('encargoPatronal', () => {
  it('20% da folha (default CPP estrita)', () => { expect(encargoPatronal(500000, 0.20)).toBe(100000); });
  it('folha null → null', () => { expect(encargoPatronal(null, 0.20)).toBeNull(); });
});

describe('anexoEfetivoFatorR', () => {
  it('massa/receita ≥ 28% → III', () => { expect(anexoEfetivoFatorR(300000, 1e6).anexo).toBe('III'); });
  it('< 28% → V', () => { expect(anexoEfetivoFatorR(100000, 1e6).anexo).toBe('V'); });
  it('massa null → banda (ambos)', () => { expect(anexoEfetivoFatorR(null, 1e6).banda).toBe(true); });
  // Mutation-check (auto-ensino 2026-06-06): testes cobriam 0.30 e 0.10, não a BORDA 0.28.
  // O limiar do fator-r é INCLUSIVO (LC 123: fator-r >= 28% → anexo III). fr==0.28 exato é
  // alcançável (280k/1M) e decide anexo III vs V (impostos bem diferentes). A mutação >=->>  sobrevivia.
  it('fator-r EXATAMENTE 28% → anexo III (limiar inclusivo, >=, não >)', () => {
    const r = anexoEfetivoFatorR(280000, 1_000_000); // 280000/1e6 === 0.28 (exato em double)
    expect(r.fator_r).toBe(0.28);
    expect(r.anexo).toBe('III');
  });
});

describe('breakEvenMargemReal', () => {
  it('retorna a margem de cruzamento direcional entre Real e Presumido', () => {
    const r = breakEvenMargemReal({ presuncaoIrpj: 0.08, presuncaoCsll: 0.12 });
    expect(r).toBeCloseTo((0.08 * 0.15 + 0.12 * 0.09) / (0.15 + 0.09), 9);
  });
});

describe('compararRegimes — ordena elegíveis asc por total_federal_cpp', () => {
  it('regime inelegível (RBA>4,8M) sai do ranking mas aparece marcado', () => {
    const comp = compararRegimes({
      simples: { total_federal_cpp: 50000, das_total: 60000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'inelegivel', motivo_inelegivel: 'RBA > 4,8M' },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 10000, total_federal_cpp: 60000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 40000, cpp: 10000, total_federal_cpp: 65000, credito_aplicado: 0, lucro_usado: 0 },
    });
    const elegiveis = comp.filter((c) => c.elegivel);
    expect(elegiveis[0].regime).toBe('presumido');
    expect(comp.find((c) => c.regime === 'simples')!.elegivel).toBe(false);
  });
});

describe('recomendarRegime', () => {
  it('recomenda o menor; economia = atual − recomendado ≥ 0', () => {
    const comparados = compararRegimes({
      simples: { total_federal_cpp: 40000, das_total: 50000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'elegivel', motivo_inelegivel: null },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 10000, total_federal_cpp: 60000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 40000, cpp: 10000, total_federal_cpp: 65000, credito_aplicado: 0, lucro_usado: 0 },
    });
    const r = recomendarRegime(comparados, 'presumido', { bandaErro: 0.05 });
    expect(r.recomendado).toBe('simples');
    expect(r.economia_anual).toBeCloseTo(60000 - 40000, 0);
    expect(r.status).toBe('recomenda');
  });
  it('economia dentro da banda de erro + recomendado=real → empate_tecnico', () => {
    const comparados = compararRegimes({
      simples: { total_federal_cpp: 100000, das_total: 110000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'elegivel', motivo_inelegivel: null },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 10000, total_federal_cpp: 61000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 35000, cpp: 10000, total_federal_cpp: 60000, credito_aplicado: 0, lucro_usado: 100000 },
    });
    const r = recomendarRegime(comparados, 'presumido', { bandaErro: 0.05 });
    expect(r.status).toBe('empate_tecnico');
  });
  it('regime atual já é o melhor → manter, economia 0', () => {
    const comparados = compararRegimes({
      simples: { total_federal_cpp: 40000, das_total: 50000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'elegivel', motivo_inelegivel: null },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 10000, total_federal_cpp: 60000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 40000, cpp: 10000, total_federal_cpp: 65000, credito_aplicado: 0, lucro_usado: 0 },
    });
    const r = recomendarRegime(comparados, 'simples', { bandaErro: 0.05 });
    expect(r.status).toBe('manter');
    expect(r.economia_anual).toBe(0);
  });
});

describe('scoreConfiancaRegime', () => {
  it('Real sempre ≤ media (LALUR não modelado)', () => {
    const c = scoreConfiancaRegime({ recomendado: 'real', folhaConhecida: true, semFlagsFortes: true });
    expect(c.nivel === 'alta').toBe(false);
  });
  it('sem folha → rebaixa + motivo', () => {
    const c = scoreConfiancaRegime({ recomendado: 'presumido', folhaConhecida: false, semFlagsFortes: true });
    expect(c.nivel).not.toBe('alta');
    expect(c.motivos.join(' ')).toMatch(/folha/i);
  });
  it('tudo ok + recomendado presumido → alta', () => {
    const c = scoreConfiancaRegime({ recomendado: 'presumido', folhaConhecida: true, semFlagsFortes: true });
    expect(c.nivel).toBe('alta');
  });
});

describe('recomendarRegime — degradação por dados incompletos', () => {
  it('dadosCompletos=false → status incompleto, economia null (não fabrica recomendação confiante)', () => {
    const comparados = compararRegimes({
      simples: { total_federal_cpp: 40000, das_total: 50000, icms_iss_ipi: 10000, aproximado: true },
      elegSimples: { status_elegibilidade: 'elegivel', motivo_inelegivel: null },
      presumido: { irpj: 30000, csll: 20000, pis: 0, cofins: 0, cpp: 0, total_federal_cpp: 50000 },
      real: { irpj: 10000, csll: 5000, pis_cofins: 40000, cpp: 0, total_federal_cpp: 55000, credito_aplicado: 0, lucro_usado: 0 },
    });
    const r = recomendarRegime(comparados, 'presumido', { bandaErro: 0.05, dadosCompletos: false });
    expect(r.status).toBe('incompleto');
    expect(r.economia_anual).toBeNull();
  });
});
describe('scoreConfiancaRegime — TTM incompleto', () => {
  it('ttmCompleto=false → baixa', () => {
    const c = scoreConfiancaRegime({ recomendado: 'presumido', folhaConhecida: true, semFlagsFortes: true, ttmCompleto: false });
    expect(c.nivel).toBe('baixa');
  });
});
