// scripts/orcamento-compra/pagina.test.ts
import { describe, expect, it } from 'vitest';
import { avaliarPortao, secaoCenarioGuarda, type Resultado } from './pagina';

type Estado = Resultado['ciclos'][number]['estado'];
const resultado = (o: { precisao: number | null; n: number; cobertura: number | null; estados: Estado['tipo'][] }): Resultado =>
  ({
    config: { reservaDias: 30, horizonteDias: 91 },
    sensibilidade: [{ reservaDias: 15 }, { reservaDias: 30 }, { reservaDias: 45 }],
    resumo: { precisaoEpisodios: { precisao: o.precisao, n: o.n, indeterminados: 0, valorCortado: 0 }, coberturaEpisodios: o.cobertura },
    ciclos: o.estados.map((tipo, i) => ({
      cicloId: i, data: `2026-09-${String(i + 1).padStart(2, '0')}`, status: 'disparado', valorMotor: 10, valorAceito: 1,
      estado: tipo === 'inviavel' ? { tipo, primeiraViolacao: '2026-10-01', deficitMax: 1 } : { tipo: 'viavel', piso: 0, dataPiso: '2026-10-01' },
    })),
  }) as unknown as Resultado;

describe('R31 — portão da v2 derivado do resultado', () => {
  it('abre só com todos os critérios', () => {
    expect(avaliarPortao(resultado({ precisao: 0.96, n: 30, cobertura: 0.5, estados: ['viavel'] }))).toEqual({ aberto: true, motivos: [] });
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
    expect(html).toContain('diagnóstico datado 2026-10-15, não recalculado'.replace('d', 'D'));
  });
});
