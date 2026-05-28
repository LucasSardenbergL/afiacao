import { describe, it, expect } from 'vitest';
import { entidadeDaLinha, concentrarPorEntidade, coletarTitulosEntidade, classificarReconciliacaoEntidade, parseMesDataEmissao, type EntidadeRowRaw } from '../orcamento-entidade-helpers';

const r = (id: string | null, nome: string | null, mes: number, valor: number): EntidadeRowRaw =>
  ({ entidade_id: id, entidade_nome: nome, mes, valor });
const A = '11222333000144', B = '22333444000155', C = '33444555000166', Z = '99888777000166';
const CPF = '11144477735';

describe('entidadeDaLinha', () => {
  it('pina todas as linhas: despesas→cp/fornecedor, receitas→cr/cliente, fiscais/derivadas→null', () => {
    for (const l of ['cmv','despesas_operacionais','despesas_administrativas','despesas_comerciais','despesas_financeiras','outras_despesas'])
      expect(entidadeDaLinha(l)).toEqual({ fonte: 'cp', rotulo: 'fornecedor' });
    for (const l of ['receita_bruta','receitas_financeiras','outras_receitas'])
      expect(entidadeDaLinha(l)).toEqual({ fonte: 'cr', rotulo: 'cliente' });
    for (const l of ['deducoes','impostos','resultado_operacional','lucro_bruto'])
      expect(entidadeDaLinha(l)).toBeNull();
  });
});

describe('concentrarPorEntidade', () => {
  it('agrega por cnpj, delta assinado, peso, ordena por delta desc; reconcilia total', () => {
    const rowsAno = [r(A,'A',1,300), r(A,'A',2,300), r(B,'B',1,100), r(C,'C',4,999)];
    const rowsAnoAnterior = [r(A,'A',1,200), r(B,'B',1,100)];
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: [1,2,3], topN: 2 });
    expect(res.total_ano).toBe(700);
    expect(res.total_ano_anterior).toBe(300);
    expect(res.componentes[0].entidade_chave).toBe(A);
    expect(res.componentes[0].delta).toBe(400);
    expect(res.componentes[0].peso_perc).toBeCloseTo(600/700, 5);
    expect(res.componentes[0].classe).toBe('recorrente');
    expect(res.componentes.find(c => c.entidade_chave === B)!.delta).toBe(0);
  });

  it('aumento_bruto=Σmax(delta,0) sobre TODAS (não só topN); sumiu fora; não estoura 100%', () => {
    const D = '44555666000177';
    const rowsAno = [r(A,'A',1,100), r(B,'B',1,50), r(C,'C',1,25), r(D,'D',1,25), r(Z,'Z',1,0)];
    const rowsAnoAnterior = [r(Z,'Z',1,300)];
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: [1], topN: 2 });
    expect(res.aumento_bruto).toBe(200);
    expect(res.top_n_peso_aumento_perc).toBeCloseTo(0.75, 5);
    expect(res.componentes.find(c => c.entidade_chave === A)!.classe).toBe('novo');
    expect(res.componentes.find(c => c.entidade_chave === Z)!.classe).toBe('sumiu');
  });

  it('Pareto de NÍVEL usa abs(realizado), não delta', () => {
    const rowsAno = [r(A,'A',1,10), r(B,'B',1,1000)];
    const rowsAnoAnterior = [r(B,'B',1,1100)];
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: [1], topN: 1 });
    expect(res.top_n_peso_nivel_perc).toBeCloseTo(1000/1010, 5);
  });

  it('sem aumento (tudo caiu) → top_n_peso_aumento_perc null + sem_aumento_bruto', () => {
    const res = concentrarPorEntidade({ rowsAno: [r(A,'A',1,100)], rowsAnoAnterior: [r(A,'A',1,300)], mesesFechados: [1], topN: 3 });
    expect(res.aumento_bruto).toBe(0);
    expect(res.sem_aumento_bruto).toBe(true);
    expect(res.top_n_peso_aumento_perc).toBeNull();
  });

  it('identidade: cnpj sentinela/curto → nome normalizado; sem nome → sem_identificacao', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r('00000000000000','Posto X',1,100), r('','  posto x ',2,50), r(null,null,1,30)],
      rowsAnoAnterior: [], mesesFechados: [1,2], topN: 3,
    });
    const posto = res.componentes.find(c => c.entidade_chave === 'POSTO X');
    expect(posto!.realizado_ytd).toBe(150);
    expect(posto!.sem_id).toBe(true);
    expect(res.componentes.find(c => c.entidade_chave === 'sem_identificacao')!.realizado_ytd).toBe(30);
  });

  it('cnpj com máscara e CPF (11) viram dígitos limpos; mês null/fora ignorado; sem NaN', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r('11.222.333/0001-44','A',1,100), r(CPF,'Pessoa',1,40), { entidade_id:'x', entidade_nome:'A', mes:null, valor:999 }],
      rowsAnoAnterior: [], mesesFechados: [1], topN: 3,
    });
    expect(res.componentes.find(c => c.entidade_chave === A)).toBeDefined();
    expect(res.componentes.find(c => c.entidade_chave === CPF)).toBeDefined();
    expect(res.total_ano).toBe(140);
    expect(res.componentes.every(c => Number.isFinite(c.peso_perc))).toBe(true);
  });

  it('truncado repassado; total zero → pesos 0 sem Infinity', () => {
    const res = concentrarPorEntidade({ rowsAno: [], rowsAnoAnterior: [], mesesFechados: [1], topN: 3, truncado: true });
    expect(res.truncado).toBe(true);
    expect(res.total_ano).toBe(0);
    expect(res.top_n_peso_nivel_perc).toBe(0);
  });
});

describe('parseMesDataEmissao', () => {
  it('YYYY-MM-DD → mês; malformado/null → null', () => {
    expect(parseMesDataEmissao('2026-03-15')).toBe(3);
    expect(parseMesDataEmissao('2026-12-01')).toBe(12);
    expect(parseMesDataEmissao(null)).toBeNull();
    expect(parseMesDataEmissao('lixo')).toBeNull();
  });
});

describe('coletarTitulosEntidade', () => {
  it('parte códigos em lotes, pagina por lote, acumula; truncado=false abaixo do teto', async () => {
    const calls: Array<{ lote: string[]; offset: number }> = [];
    const fake = async (lote: string[], offset: number): Promise<EntidadeRowRaw[]> => {
      calls.push({ lote, offset });
      if (lote.includes('x') && offset === 0) return [r(A,'A',1,10), r(B,'B',1,20)];
      return [];
    };
    const res = await coletarTitulosEntidade({ codigos: ['x','y'], fetchPagina: fake, chunkCodigos: 1, pageSize: 1000, max: 20000 });
    expect(res.truncado).toBe(false);
    expect(res.rows).toHaveLength(2);
    expect(calls.some(c => c.lote.includes('x'))).toBe(true);
    expect(calls.some(c => c.lote.includes('y'))).toBe(true);
  });
  it('para no teto MAX e marca truncado', async () => {
    const fake = async (_lote: string[], offset: number): Promise<EntidadeRowRaw[]> =>
      offset === 0 ? [r(A,'A',1,1), r(B,'B',1,1), r(C,'C',1,1)] : [];
    const res = await coletarTitulosEntidade({ codigos: ['x','y','z'], fetchPagina: fake, chunkCodigos: 1, pageSize: 1000, max: 2 });
    expect(res.truncado).toBe(true);
    expect(res.rows).toHaveLength(2);
  });
  it('códigos vazio → vazio sem chamar fetch', async () => {
    let chamou = false;
    const res = await coletarTitulosEntidade({ codigos: [], fetchPagina: async () => { chamou = true; return []; }, chunkCodigos: 1, pageSize: 1000, max: 20000 });
    expect(res.rows).toHaveLength(0); expect(chamou).toBe(false);
  });
});

describe('classificarReconciliacaoEntidade (Codex P1: v2 pode divergir do v1)', () => {
  it('truncado → diagnostico; alvo ausente → ok sem diff', () => {
    expect(classificarReconciliacaoEntidade(100, 100, true).qualidade).toBe('diagnostico');
    expect(classificarReconciliacaoEntidade(100, null, false)).toEqual({ qualidade: 'ok', diff: null, diff_perc: null });
  });
  it('ok = (≤5% E ≤R$10k); parcial 5-20%; diagnostico >20%', () => {
    expect(classificarReconciliacaoEntidade(100, 101, false).qualidade).toBe('ok');      // 1%
    expect(classificarReconciliacaoEntidade(100, 110, false).qualidade).toBe('parcial'); // 9%
    expect(classificarReconciliacaoEntidade(100, 200, false).qualidade).toBe('diagnostico'); // 50%
    // % pequeno mas absoluto grande → parcial (AND)
    expect(classificarReconciliacaoEntidade(5_000_000, 5_040_000, false).qualidade).toBe('parcial');
  });
  it('alvo ~0: diff ~0 → ok; diff ≠0 → diagnostico; diff_perc null', () => {
    expect(classificarReconciliacaoEntidade(0, 0, false)).toEqual({ qualidade: 'ok', diff: 0, diff_perc: null });
    expect(classificarReconciliacaoEntidade(50, 0, false).qualidade).toBe('diagnostico');
  });
});

describe('peso_perc com total negativo (estorno dominante) usa denominador absoluto', () => {
  it('não gera % absurdo: total bruto −100, entidade −80 → peso 0.8 (abs)', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r(A, 'A', 1, -80), r(B, 'B', 1, -20)],
      rowsAnoAnterior: [], mesesFechados: [1], topN: 2,
    });
    expect(res.total_ano).toBe(-100);
    const compA = res.componentes.find(c => c.entidade_chave === A)!;
    expect(compA.peso_perc).toBeCloseTo(-80 / 100, 5); // ano/abs(total) = −80/100
    expect(res.componentes.every(c => Number.isFinite(c.peso_perc))).toBe(true);
  });
});
