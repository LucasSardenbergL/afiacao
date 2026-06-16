import { describe, it, expect } from 'vitest';
import {
  avaliarOpcao,
  escolherEmbalagemEconomica,
  type OpcaoEmbalagem,
  type ParamsEmbalagem,
} from './embalagem-helpers';

const QT: OpcaoEmbalagem = { sku_codigo_omie: 'QT1', fator_para_base: 1, preco: 10, preco_status: 'ok' };
const GL: OpcaoEmbalagem = { sku_codigo_omie: 'GL1', fator_para_base: 4, preco: 30, preco_status: 'ok' };
const semDemanda: ParamsEmbalagem = { custo_capital_anual: 0.3, limiar_minimo_economia_rs: 5, demanda_base_diaria: null };

describe('avaliarOpcao', () => {
  it('GL com necessidade 1: 1 embalagem, excedente 3, sem capital quando demanda ausente', () => {
    const a = avaliarOpcao(1, GL, semDemanda);
    expect(a).not.toBeNull();
    expect(a!.qtd_embalagens).toBe(1);
    expect(a!.unidades_base_compradas).toBe(4);
    expect(a!.excedente_base).toBe(3);
    expect(a!.custo_direto).toBe(30);
    expect(a!.capital_carrego).toBeNull();
    expect(a!.custo_total_ajustado).toBe(30);
  });

  it('QT casa exato quando necessidade = 4 (sem excedente)', () => {
    const a = avaliarOpcao(4, QT, { ...semDemanda, demanda_base_diaria: 2 });
    expect(a!.qtd_embalagens).toBe(4);
    expect(a!.excedente_base).toBe(0);
    expect(a!.custo_direto).toBe(40);
    expect(a!.capital_carrego).toBe(0);
  });

  it('capital de carrego do excedente é descontado quando há demanda', () => {
    const a = avaliarOpcao(1, { ...GL, preco: 30 }, { custo_capital_anual: 0.5, limiar_minimo_economia_rs: 5, demanda_base_diaria: 0.02 });
    expect(a!.capital_carrego).toBeCloseTo(3 * 7.5 * 0.5 * (150 / 365), 4);
    expect(a!.custo_total_ajustado).toBeCloseTo(30 + 3 * 7.5 * 0.5 * (150 / 365), 4);
  });

  it('retorna null quando preço ausente ou fator inválido', () => {
    expect(avaliarOpcao(1, { ...GL, preco: null }, semDemanda)).toBeNull();
    expect(avaliarOpcao(1, { ...GL, fator_para_base: 0 }, semDemanda)).toBeNull();
  });
});

const params = (over: Partial<ParamsEmbalagem> = {}): ParamsEmbalagem =>
  ({ custo_capital_anual: 0.3, limiar_minimo_economia_rs: 5, demanda_base_diaria: 2, ...over });

describe('escolherEmbalagemEconomica', () => {
  it('QT vence quando GL é caro (necessidade pequena)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 50, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.status).toBe('ok');
    expect(r.recomendada).toBe('QT');
  });

  it('GL vence quando necessidade é grande e GL/4 < QT', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.recomendada).toBe('GL');
  });

  it('escoamento lento: o carrego come o crédito da sobra → QT', () => {
    // GL absoluto mais barato (9 < 10), MAS demanda quase nula → a sobra leva ~3000
    // dias a escoar → carrego (R$27,7) engole o crédito (R$6,75) → conservador.
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 9, preco_status: 'ok' },
      ],
      params: params({ custo_capital_anual: 0.5, demanda_base_diaria: 0.001 }),
    });
    expect(r.recomendada).toBe('QT');
  });

  it('economia abaixo do limiar não empurra overbuy (marginal → recomenda a sem excedente)', () => {
    // GL R$39,60 = R$9,90/un-base vs QT R$10: ganho efetivo no ciclo = R$0,10 < limiar 1.
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 39.6, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: 1000, limiar_minimo_economia_rs: 1 }),
    });
    expect(r.status).toBe('marginal');
    expect(r.recomendada).toBe('QT');
    expect(r.flags).toContain('overbuy_marginal');
  });

  it('menos de 2 preços informados → indisponivel', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: null, preco_status: null },
      ],
      params: params(),
    });
    expect(r.status).toBe('indisponivel');
    expect(r.recomendada).toBeNull();
  });

  it('preço stale não bloqueia, mas sinaliza', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'stale' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(r.status).not.toBe('indisponivel');
    expect(r.flags).toContain('preco_desatualizado');
  });

  it('demanda ausente: recomenda por custo direto + flag de escoamento', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: null }),
    });
    expect(r.recomendada).toBe('GL');
    expect(r.capital_estimado).toBeNull();
    expect(r.flags).toContain('escoamento_nao_estimado');
  });

  it('economia_vs_alternativa reflete a recomendada (0 quando marginal, >0 quando normal)', () => {
    const marginal = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 39.6, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: 1000, limiar_minimo_economia_rs: 1 }),
    });
    expect(marginal.recomendada).toBe('QT');
    expect(marginal.economia_vs_alternativa).toBe(0);

    const normal = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(normal.recomendada).toBe('GL');
    expect(normal.economia_vs_alternativa).toBeGreaterThan(0);
  });

  it('necessidade_base 0 ou negativa → indisponivel', () => {
    const mk = (n: number) => escolherEmbalagemEconomica({
      necessidade_base: n,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 30, preco_status: 'ok' },
      ],
      params: params(),
    });
    expect(mk(0).status).toBe('indisponivel');
    expect(mk(-5).status).toBe('indisponivel');
  });
});

// ─── v1.1 — crédito de reposição da sobra (spec §14) ───────────────────────────
// Caso real do founder (WP01): GL 6,2% mais barato por QT-equivalente, mas a v1
// indicava QT pra toda necessidade não-múltipla de 4 (sobra = custo morto integral).
const QT_WP01: OpcaoEmbalagem = { sku_codigo_omie: 'QT_WP01', fator_para_base: 1, preco: 81.7068, preco_status: 'ok' };
const GL_WP01: OpcaoEmbalagem = { sku_codigo_omie: 'GL_WP01', fator_para_base: 4, preco: 306.4977, preco_status: 'ok' };
const BASE_GL = 306.4977 / 4; // 76.624425 = melhor custo/base do grupo
const paramsWP01 = (over: Partial<ParamsEmbalagem> = {}): ParamsEmbalagem =>
  ({ custo_capital_anual: 0.3, limiar_minimo_economia_rs: 5, demanda_base_diaria: 0.2244, ...over });
const carrego = (exc: number, custoBase: number, cm: number, demanda: number) =>
  exc * custoBase * cm * ((exc / demanda) / 365);

describe('v1.1 — crédito de reposição da sobra', () => {
  it('WP01 real, necessidade 2: GL vence (sobra de 2 QT antecipa a próxima compra)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 2,
      opcoes: [QT_WP01, GL_WP01],
      params: paramsWP01(),
    });
    expect(r.recomendada).toBe('GL_WP01');
    expect(r.status).toBe('ok');
    expect(r.flags).toContain('sobra_antecipa_compra');
    const totalGL = 306.4977 + carrego(2, BASE_GL, 0.3, 0.2244) - 2 * BASE_GL;
    expect(r.economia_vs_alternativa).toBeCloseTo(2 * 81.7068 - totalGL, 4); // ≈ R$9,04
  });

  it('WP01 real, necessidade 1: ganho de ~R$2,56 fica abaixo do limiar → marginal → QT', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [QT_WP01, GL_WP01],
      params: paramsWP01(),
    });
    expect(r.status).toBe('marginal');
    expect(r.recomendada).toBe('QT_WP01');
    expect(r.flags).toContain('overbuy_marginal');
  });

  it('WP01 real, necessidade 4: GL sem sobra, economia direta de ~R$20,33', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 4,
      opcoes: [QT_WP01, GL_WP01],
      params: paramsWP01(),
    });
    expect(r.recomendada).toBe('GL_WP01');
    expect(r.excedente_base).toBe(0);
    expect(r.economia_vs_alternativa).toBeCloseTo(4 * 81.7068 - 306.4977, 4);
    expect(r.flags).not.toContain('sobra_antecipa_compra');
    expect(r.dias_escoamento_sobra).toBeNull();
  });

  // Decisão do founder (2026-06-11, spec §14.2): sem demanda registrada, recomenda
  // pela embalagem mais barata por unidade-base (o item gira — consumo interno oculto),
  // com aviso. NÃO banca crédito (sem escoamento estimável) → economia_vs_alternativa 0.
  it('sem demanda: recomenda pelo menor custo/base (GL) com aviso, sem inventar economia', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [QT_WP01, GL_WP01],
      params: paramsWP01({ demanda_base_diaria: null }),
    });
    expect(r.recomendada).toBe('GL_WP01'); // 76,62/base < 81,71/base
    expect(r.flags).toContain('escoamento_nao_estimado');
    expect(r.flags).not.toContain('sobra_antecipa_compra'); // não banca sem demanda
    expect(r.economia_vs_alternativa).toBe(0); // sem escoamento, não afirma R$ economizado
    expect(r.capital_estimado).toBeNull();
  });

  it('sem demanda: empate de custo/base mantém determinístico (não quebra)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 2,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 40, preco_status: 'ok' }, // 10/base = QT
      ],
      params: params({ demanda_base_diaria: null }),
    });
    expect(['QT', 'GL']).toContain(r.recomendada); // empate: qualquer um é válido, sem crash
    expect(r.flags).toContain('escoamento_nao_estimado');
  });

  it('necessidade fracionária: ambas as opções têm sobra com crédito (sem guard marginal aplicável)', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 2.5,
      opcoes: [QT_WP01, GL_WP01],
      params: paramsWP01(),
    });
    expect(r.recomendada).toBe('GL_WP01');
    expect(r.status).toBe('ok');
  });

  // [codex P1] o guard marginal usava `excedente === 0`. Com necessidade fracionária
  // NENHUMA opção casa exato → guard não disparava e o GL ganhava por centavos.
  // A conservadora correta é a de MENOR excedente, não a de excedente zero.
  it('necessidade fracionária + ganho ínfimo: guard marginal usa a opção de MENOR sobra → QT', () => {
    const r = escolherEmbalagemEconomica({
      necessidade_base: 2.5,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },     // ceil 3, sobra 0,5
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 39.99, preco_status: 'ok' },   // ceil 1, sobra 1,5
      ],
      params: params({ demanda_base_diaria: 1000, limiar_minimo_economia_rs: 5 }), // GL ganha por ~R$0,0075
    });
    expect(r.status).toBe('marginal');
    expect(r.recomendada).toBe('QT');
    expect(r.flags).toContain('overbuy_marginal');
  });

  it('necessidade fracionária + ganho real acima do limiar: overbuy compensa → GL', () => {
    // mesma estrutura, mas GL genuinamente barato → ganho >> R$5 → mantém GL.
    const r = escolherEmbalagemEconomica({
      necessidade_base: 2.5,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 24, preco_status: 'ok' }, // R$6/base
      ],
      params: params({ demanda_base_diaria: 1000, limiar_minimo_economia_rs: 5 }),
    });
    expect(r.status).toBe('ok');
    expect(r.recomendada).toBe('GL');
    expect(r.flags).toContain('overbuy_compensa');
  });

  it('dias_escoamento_sobra exposto quando a recomendada tem sobra; null no marginal', () => {
    const comSobra = escolherEmbalagemEconomica({
      necessidade_base: 2,
      opcoes: [QT_WP01, GL_WP01],
      params: paramsWP01(),
    });
    expect(comSobra.dias_escoamento_sobra).toBeCloseTo(2 / 0.2244, 4);

    const marginal = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [QT_WP01, GL_WP01],
      params: paramsWP01(),
    });
    expect(marginal.dias_escoamento_sobra).toBeNull(); // recomendada (QT) não tem sobra
  });

  it('invariante: custo_total ≥ necessidade × custo/base da opção (crédito nunca negativa o custo)', () => {
    // GL absoluto mais barato que QT (promoção): compra dominante, crédito grande.
    const r = escolherEmbalagemEconomica({
      necessidade_base: 1,
      opcoes: [
        { sku_codigo_omie: 'QT', fator_para_base: 1, preco: 10, preco_status: 'ok' },
        { sku_codigo_omie: 'GL', fator_para_base: 4, preco: 9, preco_status: 'ok' },
      ],
      params: params({ demanda_base_diaria: 1000 }),
    });
    expect(r.recomendada).toBe('GL');
    for (const o of r.opcoes) {
      expect(o.custo_total_ajustado).toBeGreaterThanOrEqual(1 * o.custo_por_base - 1e-9);
      expect(o.custo_total_ajustado).toBeGreaterThanOrEqual(0);
    }
  });

  it('avaliarOpcao: crédito = excedente × preço de reposição, capado no custo/base da própria opção', () => {
    const gl: OpcaoEmbalagem = { sku_codigo_omie: 'GL1', fator_para_base: 4, preco: 30, preco_status: 'ok' };
    const p: ParamsEmbalagem = { custo_capital_anual: 0.5, limiar_minimo_economia_rs: 5, demanda_base_diaria: 0.02 };
    const a = avaliarOpcao(1, gl, p, 7.5);
    expect(a!.credito_reposicao).toBeCloseTo(3 * 7.5, 6);
    expect(a!.custo_total_ajustado).toBeCloseTo(30 + carrego(3, 7.5, 0.5, 0.02) - 3 * 7.5, 4);

    // caller passando preço de reposição acima do custo/base da opção → capado (defesa do invariante)
    const capado = avaliarOpcao(1, gl, { ...p, demanda_base_diaria: 2 }, 99);
    expect(capado!.credito_reposicao).toBeCloseTo(3 * 7.5, 6);
  });

  it('avaliarOpcao: sem o preço de reposição (compat) ou sem demanda → crédito 0', () => {
    const gl: OpcaoEmbalagem = { sku_codigo_omie: 'GL1', fator_para_base: 4, preco: 30, preco_status: 'ok' };
    const semArg = avaliarOpcao(1, gl, params());
    expect(semArg!.credito_reposicao).toBe(0);

    const semDem = avaliarOpcao(1, gl, params({ demanda_base_diaria: null }), 7.5);
    expect(semDem!.credito_reposicao).toBe(0);
    expect(semDem!.custo_total_ajustado).toBe(30);
  });
});
