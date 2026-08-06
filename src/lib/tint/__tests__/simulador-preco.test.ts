import { describe, it, expect } from 'vitest';
import { precoSimulador } from '../simulador-preco';
import { selectAltPrice } from '../select-price';
import type { TintPriceBreakdownLite } from '../select-price';

// Helper: breakdown Lite do motor batch (get_tint_prices) para os testes.
const pricing = (over: Partial<TintPriceBreakdownLite>): TintPriceBreakdownLite => ({
  custoBase: 100,
  baseDisponivel: true,
  custoCorantes: 50,
  corantesCompletos: true,
  precoFinal: 150,
  ...over,
});

describe('precoSimulador — o simulador admin mostra o preço do BALCÃO (Fase 4, anti-desinformação)', () => {
  it('PARIDADE com selectAltPrice: mesmo preço/fonte/recalculado em toda a grade de casos', () => {
    // O critério de aceite da fase: o simulador mostra o MESMO preço que o balcão
    // cobraria. selectAltPrice é a seleção das alternativas/busca global do balcão;
    // qualquer divergência aqui = motor paralelo de volta.
    const casos: Array<{ csv: number | null; p: TintPriceBreakdownLite | null }> = [
      { csv: null, p: null },
      { csv: 120, p: null }, // sem breakdown: NÃO cai no CSV (fail-closed)
      { csv: null, p: pricing({}) },
      { csv: 100, p: pricing({ precoFinal: 150 }) }, // calc sobe → recalculado
      { csv: 200, p: pricing({ precoFinal: 150 }) }, // calc < CSV → tabela (não baixa)
      { csv: 150.05, p: pricing({ precoFinal: 150.02 }) }, // batem na tolerância
      { csv: 0, p: pricing({}) }, // CSV 0 não é fonte
      { csv: 120, p: pricing({ baseDisponivel: false, custoBase: null, precoFinal: null }) },
      { csv: 120, p: pricing({ corantesCompletos: false, precoFinal: null }) },
      { csv: 33.333, p: pricing({ precoFinal: 41.01 }) }, // arredonda a R$0,10 pra cima
      { csv: 120, p: pricing({ custoCorantes: null }) }, // custo gateado (não-staff) não muda o preço
    ];
    for (const { csv, p } of casos) {
      const alt = selectAltPrice(csv, p);
      const sim = precoSimulador({ precoCsv: csv, pricing: p, batchCarregando: false, temReceita: true });
      expect(sim.preco, `preco p/ csv=${csv}`).toBe(alt.preco);
      expect(sim.fonte, `fonte p/ csv=${csv}`).toBe(alt.fonte);
      expect(sim.recalculado, `recalculado p/ csv=${csv}`).toBe(alt.recalculado);
      expect(sim.status).toBe(alt.preco != null ? 'com-preco' : 'sem-preco');
    }
  });

  it('batch CARREGANDO segura o preço — não cai no CSV enquanto o motor não respondeu', () => {
    // Fail-open clássico: mostrar o CSV "enquanto carrega" exibiria preço que a RPC
    // pode estar barrando (base inativa). Carregando = sem número nenhum.
    const r = precoSimulador({ precoCsv: 999, pricing: null, batchCarregando: true, temReceita: true });
    expect(r.status).toBe('carregando');
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
    expect(r.motivo).toBeNull();
  });

  it('batch respondeu SEM a fórmula (erro/id desconhecido) → sem preço "indisponível", ignora CSV', () => {
    const r = precoSimulador({ precoCsv: 999, pricing: null, batchCarregando: false, temReceita: true });
    expect(r.status).toBe('sem-preco');
    expect(r.preco).toBeNull();
    expect(r.motivo).toMatch(/não respondeu/i);
  });

  it('recalculado (Grupo B) expõe o CSV anterior para o aviso "antes R$X"', () => {
    const r = precoSimulador({
      precoCsv: 100,
      pricing: pricing({ precoFinal: 150 }),
      batchCarregando: false,
      temReceita: true,
    });
    expect(r.status).toBe('com-preco');
    expect(r.preco).toBe(150);
    expect(r.fonte).toBe('calculado');
    expect(r.recalculado).toBe(true);
    expect(r.precoImportadoAnterior).toBe(100);
  });

  it('com-preco expõe os DOIS candidatos do seletor da vendedora (calc × tabela), arredondados', () => {
    // O balcão oferece a escolha entre "Calculado" e "Tabela (versão anterior)";
    // a tela de quem precifica precisa ver o par — com o arredondamento do balcão
    // (ceil a R$0,10), nunca o valor cru.
    const r = precoSimulador({
      precoCsv: 100.02,
      pricing: pricing({ precoFinal: 150.01 }),
      batchCarregando: false,
      temReceita: true,
    });
    expect(r.precoCalc).toBe(150.1);
    expect(r.precoTabela).toBe(100.1);
    expect(r.preco).toBe(r.precoCalc); // o escolhido é o maior (regra 3)
  });

  it('sem-preco NÃO expõe candidato nenhum — o balcão bloqueia TODAS as fontes', () => {
    // semPrecoConfiavel no balcão zera calc/tabela/cliente; mostrar o CSV aqui
    // seria exibir número que a venda não pode usar (desinformação de volta).
    const r = precoSimulador({
      precoCsv: 120,
      pricing: pricing({ baseDisponivel: false, custoBase: null, precoFinal: null }),
      batchCarregando: false,
      temReceita: true,
    });
    expect(r.precoCalc).toBeNull();
    expect(r.precoTabela).toBeNull();
    expect(r.preco).toBeNull();
  });

  it('base ausente/zero → sem preço com motivo da BASE (corrigir no Omie), nunca o CSV', () => {
    const r = precoSimulador({
      precoCsv: 120,
      pricing: pricing({ baseDisponivel: false, custoBase: null, precoFinal: null }),
      batchCarregando: false,
      temReceita: true,
    });
    expect(r.status).toBe('sem-preco');
    expect(r.preco).toBeNull();
    expect(r.motivo).toMatch(/base/i);
  });

  it('receita VAZIA (0 corantes, as 28.609) → motivo distingue de corante sem custo', () => {
    // A RPC devolve corantesCompletos=false p/ fórmula sem item (fail-closed).
    // temReceita=false (da view canônica) refina a mensagem: é receita perdida,
    // não corante a vincular — ações diferentes p/ quem precifica.
    const semItens = pricing({ corantesCompletos: false, custoCorantes: 0, precoFinal: null });
    const vazia = precoSimulador({ precoCsv: 120, pricing: semItens, batchCarregando: false, temReceita: false });
    expect(vazia.status).toBe('sem-preco');
    expect(vazia.preco).toBeNull();
    expect(vazia.motivo).toMatch(/sem receita/i);

    const semCusto = precoSimulador({ precoCsv: 120, pricing: semItens, batchCarregando: false, temReceita: true });
    expect(semCusto.status).toBe('sem-preco');
    expect(semCusto.motivo).toMatch(/corante/i);
  });

  it('fórmula honesta completa → preço calculado arredondado a R$0,10 (paridade balcão)', () => {
    const r = precoSimulador({
      precoCsv: null,
      pricing: pricing({ precoFinal: 41.01 }),
      batchCarregando: false,
      temReceita: true,
    });
    expect(r.status).toBe('com-preco');
    expect(r.preco).toBe(41.1);
    expect(r.fonte).toBe('calculado');
    expect(r.recalculado).toBe(false);
    expect(r.precoImportadoAnterior).toBeNull();
  });

  it('calc < CSV → mantém a TABELA (não baixa silenciosamente na transição)', () => {
    const r = precoSimulador({
      precoCsv: 200,
      pricing: pricing({ precoFinal: 150 }),
      batchCarregando: false,
      temReceita: true,
    });
    expect(r.status).toBe('com-preco');
    expect(r.preco).toBe(200);
    expect(r.fonte).toBe('tabela');
    expect(r.recalculado).toBe(false);
  });
});
