// scripts/orcamento-compra/pagina.test.ts
import { describe, expect, it } from 'vitest';
import { avaliarPortao, gerarPagina, secaoCenarioGuarda, type Resultado } from './pagina';
import { PREMISSAS } from './simular';

type Estado = Resultado['ciclos'][number]['estado'];
const resultado = (o: { precisao: number | null | undefined; n: number | undefined; cobertura: number | null | undefined; estados: Estado['tipo'][] }): Resultado =>
  ({
    config: { reservaDias: 30, horizonteDias: 91 },
    sensibilidade: [{ reservaDias: 15 }, { reservaDias: 30 }, { reservaDias: 45 }],
    resumo: { precisaoEpisodios: { precisao: o.precisao, n: o.n, indeterminados: 0, valorCortado: 0 }, coberturaEpisodios: o.cobertura },
    ciclos: o.estados.map((tipo, i) => ({
      cicloId: i, data: `2026-09-${String(i + 1).padStart(2, '0')}`, status: 'disparado', valorMotor: 10, valorAceito: 1,
      estado: tipo === 'inviavel' ? { tipo, primeiraViolacao: '2026-10-01', deficitMax: 1 }
        : tipo === 'indeterminado' ? { tipo, camadas: ['snapshot'], piso: null }
          : { tipo: 'viavel', piso: 0, dataPiso: '2026-10-01' },
      cortesPorMotivo: {},
    })),
  }) as unknown as Resultado;

describe('R31 — portão da v2 derivado do resultado', () => {
  it('abre só com todos os critérios', () => {
    expect(avaliarPortao(resultado({ precisao: 0.96, n: 30, cobertura: 0.5, estados: ['viavel'] }))).toEqual({ aberto: true, motivos: [] });
  });

  it('R55: o portão exige evidência positiva — ≥1 ciclo e todos viáveis; sem ciclos ou estado desconhecido fecha', () => {
    const vazio = avaliarPortao(resultado({ precisao: 0.96, n: 30, cobertura: 0.5, estados: [] }));
    expect(vazio.aberto).toBe(false);
    expect(vazio.motivos.join('|')).toContain('nenhum ciclo');
    const r = resultado({ precisao: 0.96, n: 30, cobertura: 0.5, estados: ['viavel', 'viavel'] });
    (r.ciclos[1] as { estado: unknown }).estado = { tipo: 'xpto' };
    const estranho = avaliarPortao(r);
    expect(estranho.aberto).toBe(false);
    expect(estranho.motivos.join('|')).toContain('estado desconhecido');
  });
  it('lista cada critério que falha; cobertura ausente nunca passa', () => {
    const p = avaliarPortao(resultado({ precisao: 1, n: 29, cobertura: null, estados: ['inviavel', 'viavel'] }));
    expect(p.aberto).toBe(false);
    expect(p.motivos.join(' | ')).toContain('29 episódios classificados');
    expect(p.motivos.join(' | ')).toContain('cobertura insuficiente');
    expect(p.motivos.join(' | ')).toContain('1 ciclos inviáveis');
    expect(p.motivos.some((m) => m.startsWith('precisão'))).toBe(false);
  });
  it('precisão ausente fecha o portão (nunca 100% fabricado)', () => {
    const p = avaliarPortao(resultado({ precisao: null, n: 40, cobertura: 0.9, estados: ['viavel'] }));
    expect(p.motivos).toHaveLength(1);
    expect(p.motivos[0]).toContain('precisão por episódio');
  });
});

describe('R31 — seção do cenário-guarda', () => {
  it('não aparece sem ciclo inviável', () => {
    expect(secaoCenarioGuarda(resultado({ precisao: 1, n: 30, cobertura: 1, estados: ['viavel'] }))).toBe('');
  });
  it('usa horizonte e reserva do config, não números fixos', () => {
    const r = resultado({ precisao: 1, n: 30, cobertura: 1, estados: ['inviavel'] });
    const html = secaoCenarioGuarda({ ...r, config: { ...r.config, horizonteDias: 60, reservaDias: 20 } });
    expect(html).toContain('olha 60 dias à frente');
    expect(html).toContain('acima de 20 dias de saídas');
    expect(html).toContain('Diagnóstico datado 2026-10-15, não recalculado');
  });
});

describe('R36 + R47 — portão fail-closed', () => {
  const ok = { precisao: 0.96, n: 30, cobertura: 0.5 };
  it('R36: ciclo indeterminado fecha o portão (ausência de inviável não prova viabilidade — Codex P1-5)', () => {
    const p = avaliarPortao(resultado({ ...ok, estados: ['viavel', 'indeterminado'] }));
    expect(p.aberto).toBe(false);
    expect(p.motivos).toEqual(['1 ciclos indeterminados (exige 0)']);
  });
  it('R47: n ausente ou NaN fecha o portão', () => {
    for (const n of [undefined, Number.NaN]) {
      const p = avaliarPortao(resultado({ ...ok, n, estados: ['viavel'] }));
      expect(p.aberto).toBe(false);
      expect(p.motivos.join(' | ')).toContain('episódios classificados');
    }
  });
  it('R47: cobertura e precisão undefined/NaN fecham o portão (resultado.json antigo não abre)', () => {
    for (const v of [undefined, Number.NaN]) {
      expect(avaliarPortao(resultado({ ...ok, cobertura: v, estados: ['viavel'] })).aberto).toBe(false);
      expect(avaliarPortao(resultado({ ...ok, precisao: v, estados: ['viavel'] })).aberto).toBe(false);
    }
  });
  it('R47: precisão exatamente 0,95 abre (limiar inclusivo)', () => {
    expect(avaliarPortao(resultado({ ...ok, precisao: 0.95, estados: ['viavel'] }))).toEqual({ aberto: true, motivos: [] });
  });
});

describe('gerarPagina — integração (R36, R48, R49, R51, R53)', () => {
  const completo = (): Resultado => {
    const r = resultado({ precisao: 1, n: 45, cobertura: 0.2, estados: ['viavel', 'indeterminado'] });
    return {
      ...r,
      gerado_em: '2026-10-15T12:00:00Z',
      premissas: PREMISSAS,
      config: { ...r.config, fretePerc: 0.025, minimoPedido: 0 },
      sensibilidade: [{ reservaDias: 30, valorAceito: 1, valorAceitoSemGuarda: 2, inviaveis: 0, indeterminados: 1 }],
      resumo: {
        ...r.resumo, estados: { viavel: 1, indeterminado: 1 }, precisao: { precisao: 1, n: 1, indeterminados: 0, valorCortado: 1 },
        revisaoHumana: { embalagens: 7, semPreco: 1, valor: 123 }, valorAceitoSemGuarda: 456, ciclosSemGuarda: 1,
        deltaDio: 1.5, cmvCobertura: 0.9, episodiosDio: 3, skusAvaliados: 0,
      },
    } as unknown as Resultado;
  };
  it('portão fechado com o motivo dos indeterminados e a nota de viés da precisão', () => {
    const html = gerarPagina(completo());
    expect(html).toContain('Nesta rodada: FECHADO');
    expect(html).toContain('1 ciclos indeterminados (exige 0)');
    expect(html).toContain('vira indeterminado por construção');
  });
  it('R48/R51: KPIs de revisão humana e de aceito sem guarda de caixa', () => {
    const html = gerarPagina(completo());
    expect(html).toContain('Revisão humana (sem score)');
    expect(html).toContain('Aceito sem guarda de caixa');
  });
  it('R53: rótulo do ΔDIO diz o sinal e que é soma dos episódios medidos', () => {
    const html = gerarPagina(completo());
    expect(html).toContain('positivo = menos estoque');
    expect(html).toContain('soma dos episódios medidos, não média do período');
  });
  it('R49: premissas declaram oportunidade de 1 dia, margem cheia sobre backlog e promoção tudo-ou-nada', () => {
    const txt = PREMISSAS.join(' | ');
    expect(txt).toContain('intervalo de oportunidade de 1 dia');
    expect(txt).toContain('margem cheia sobre o backlog');
    expect(txt).toContain('promoção tudo-ou-nada');
  });
});

