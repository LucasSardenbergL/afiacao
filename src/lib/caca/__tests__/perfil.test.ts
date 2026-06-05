import { describe, it, expect } from 'vitest';
import { perfilPorLift } from '../perfil';
import type { MelhorCliente } from '../types';


describe('perfilPorLift', () => {
  describe('lift de ramo', () => {
    it('ramo desproporcional nos melhores → lift > 1', () => {
      // 6 de 10 melhores = "marcenaria" (60%)
      // 2 de 10 base = "marcenaria" (20%)
      // lift = 0.6 / 0.2 = 3
      const melhores: MelhorCliente[] = [
        ...Array(6).fill({ documento: '1', cidadeUf: null, ramo: 'marcenaria', ticketFaixa: null, familias: [] }),
        ...Array(4).fill({ documento: '2', cidadeUf: null, ramo: 'industria', ticketFaixa: null, familias: [] }),
      ];
      const baseClientes = [
        ...Array(2).fill({ cidadeUf: null, ramo: 'marcenaria', familias: [] }),
        ...Array(8).fill({ cidadeUf: null, ramo: 'industria', familias: [] }),
      ];
      const perfil = perfilPorLift(melhores, baseClientes, { suporteMin: 3 });
      expect(perfil.ramoLift['marcenaria']).toBeCloseTo(3.0, 1);
    });

    it('valor que reflete a base (mesma frequência) → lift próximo de 1', () => {
      // "industria" = 40% melhores e 40% base → lift ~1
      const melhores: MelhorCliente[] = [
        ...Array(4).fill({ documento: '1', cidadeUf: null, ramo: 'industria', ticketFaixa: null, familias: [] }),
        ...Array(6).fill({ documento: '2', cidadeUf: null, ramo: 'outro', ticketFaixa: null, familias: [] }),
      ];
      const baseClientes = [
        ...Array(4).fill({ cidadeUf: null, ramo: 'industria', familias: [] }),
        ...Array(6).fill({ cidadeUf: null, ramo: 'outro', familias: [] }),
      ];
      const perfil = perfilPorLift(melhores, baseClientes, { suporteMin: 3 });
      expect(perfil.ramoLift['industria']).toBeCloseTo(1.0, 1);
    });
  });

  describe('suporte mínimo', () => {
    it('valor com suporte < suporteMin → lift neutro (1)', () => {
      // "nicho" aparece só 2x nos melhores, suporteMin=3 → lift=1
      const melhores: MelhorCliente[] = [
        ...Array(2).fill({ documento: '1', cidadeUf: null, ramo: 'nicho', ticketFaixa: null, familias: [] }),
        ...Array(8).fill({ documento: '2', cidadeUf: null, ramo: 'grande', ticketFaixa: null, familias: [] }),
      ];
      const baseClientes = [
        ...Array(1).fill({ cidadeUf: null, ramo: 'nicho', familias: [] }),
        ...Array(9).fill({ cidadeUf: null, ramo: 'grande', familias: [] }),
      ];
      const perfil = perfilPorLift(melhores, baseClientes, { suporteMin: 3 });
      expect(perfil.ramoLift['nicho']).toBe(1);
    });

    it('suporteMin default 3 é respeitado', () => {
      const melhores: MelhorCliente[] = [
        ...Array(2).fill({ documento: '1', cidadeUf: null, ramo: 'raro', ticketFaixa: null, familias: [] }),
        ...Array(8).fill({ documento: '2', cidadeUf: null, ramo: 'comum', ticketFaixa: null, familias: [] }),
      ];
      const baseClientes = [
        { cidadeUf: null, ramo: 'raro', familias: [] },
        ...Array(9).fill({ cidadeUf: null, ramo: 'comum', familias: [] }),
      ];
      // Sem passar opts → default suporteMin=3 → nicho com 2 → lift=1
      const perfil = perfilPorLift(melhores, baseClientes);
      expect(perfil.ramoLift['raro']).toBe(1);
    });
  });

  describe('teto de lift', () => {
    it('lift calculado acima do teto → saturado no teto', () => {
      // "exclusivo" = 100% dos melhores, 1% da base → lift=100, saturado no teto=5
      const melhores: MelhorCliente[] = Array(10).fill({
        documento: '1', cidadeUf: 'EXCLUSIVO-MG', ramo: null, ticketFaixa: null, familias: [],
      });
      const baseClientes = [
        { cidadeUf: 'EXCLUSIVO-MG', familias: [], ramo: null },
        ...Array(99).fill({ cidadeUf: 'OUTRO-MG', familias: [], ramo: null }),
      ];
      const perfil = perfilPorLift(melhores, baseClientes, { suporteMin: 3, tetoLift: 5 });
      expect(perfil.regiaoLift['EXCLUSIVO-MG']).toBe(5);
    });

    it('tetoLift default 5 é respeitado', () => {
      const melhores: MelhorCliente[] = Array(5).fill({
        documento: '1', cidadeUf: 'UNICA-MG', ramo: null, ticketFaixa: null, familias: [],
      });
      const baseClientes = [
        { cidadeUf: 'UNICA-MG', familias: [], ramo: null },
        ...Array(99).fill({ cidadeUf: 'OUTRAS-MG', familias: [], ramo: null }),
      ];
      const perfil = perfilPorLift(melhores, baseClientes);
      expect(perfil.regiaoLift['UNICA-MG']).toBeLessThanOrEqual(5);
    });
  });

  describe('ticketMediano', () => {
    it('mediana de lista ímpar', () => {
      const melhores: MelhorCliente[] = [
        { documento: '1', cidadeUf: null, ramo: null, ticketFaixa: 100, familias: [] },
        { documento: '2', cidadeUf: null, ramo: null, ticketFaixa: 200, familias: [] },
        { documento: '3', cidadeUf: null, ramo: null, ticketFaixa: 300, familias: [] },
      ];
      const perfil = perfilPorLift(melhores, []);
      expect(perfil.ticketMediano).toBe(200);
    });

    it('mediana de lista par (média dos dois centrais)', () => {
      const melhores: MelhorCliente[] = [
        { documento: '1', cidadeUf: null, ramo: null, ticketFaixa: 100, familias: [] },
        { documento: '2', cidadeUf: null, ramo: null, ticketFaixa: 200, familias: [] },
        { documento: '3', cidadeUf: null, ramo: null, ticketFaixa: 300, familias: [] },
        { documento: '4', cidadeUf: null, ramo: null, ticketFaixa: 400, familias: [] },
      ];
      const perfil = perfilPorLift(melhores, []);
      expect(perfil.ticketMediano).toBe(250);
    });

    it('null é ignorado no cálculo da mediana', () => {
      const melhores: MelhorCliente[] = [
        { documento: '1', cidadeUf: null, ramo: null, ticketFaixa: null, familias: [] },
        { documento: '2', cidadeUf: null, ramo: null, ticketFaixa: 200, familias: [] },
        { documento: '3', cidadeUf: null, ramo: null, ticketFaixa: null, familias: [] },
      ];
      const perfil = perfilPorLift(melhores, []);
      expect(perfil.ticketMediano).toBe(200);
    });

    it('todos null → ticketMediano null', () => {
      const melhores: MelhorCliente[] = [
        { documento: '1', cidadeUf: null, ramo: null, ticketFaixa: null, familias: [] },
      ];
      const perfil = perfilPorLift(melhores, []);
      expect(perfil.ticketMediano).toBeNull();
    });
  });

  describe('lift de famílias', () => {
    it('família mais comum nos melhores tem lift > 1', () => {
      // "abrasivos" = 80% das linhas de família dos melhores (4 de 5), 20% da base
      const melhores: MelhorCliente[] = [
        { documento: '1', cidadeUf: null, ramo: null, ticketFaixa: null, familias: ['abrasivos'] },
        { documento: '2', cidadeUf: null, ramo: null, ticketFaixa: null, familias: ['abrasivos'] },
        { documento: '3', cidadeUf: null, ramo: null, ticketFaixa: null, familias: ['abrasivos'] },
        { documento: '4', cidadeUf: null, ramo: null, ticketFaixa: null, familias: ['abrasivos'] },
        { documento: '5', cidadeUf: null, ramo: null, ticketFaixa: null, familias: ['tintas'] },
      ];
      const baseClientes = [
        { cidadeUf: null, ramo: null, familias: ['abrasivos'] },
        { cidadeUf: null, ramo: null, familias: ['tintas'] },
        { cidadeUf: null, ramo: null, familias: ['tintas'] },
        { cidadeUf: null, ramo: null, familias: ['tintas'] },
        { cidadeUf: null, ramo: null, familias: ['tintas'] },
      ];
      const perfil = perfilPorLift(melhores, baseClientes, { suporteMin: 3 });
      expect(perfil.familiaLift['abrasivos']).toBeGreaterThan(1);
    });
  });

  describe('ramo null é ignorado', () => {
    it('null em ramo não entra no ramoLift', () => {
      const melhores: MelhorCliente[] = [
        { documento: '1', cidadeUf: null, ramo: null, ticketFaixa: null, familias: [] },
        { documento: '2', cidadeUf: null, ramo: 'marcenaria', ticketFaixa: null, familias: [] },
        { documento: '3', cidadeUf: null, ramo: 'marcenaria', ticketFaixa: null, familias: [] },
        { documento: '4', cidadeUf: null, ramo: 'marcenaria', ticketFaixa: null, familias: [] },
      ];
      const perfil = perfilPorLift(melhores, [{ cidadeUf: null, ramo: null, familias: [] }]);
      expect(Object.keys(perfil.ramoLift)).not.toContain('null');
      expect(Object.keys(perfil.ramoLift)).not.toContain('');
    });
  });

  describe('nMelhores', () => {
    it('reflete o número de melhores clientes passados', () => {
      const melhores: MelhorCliente[] = Array(7).fill({
        documento: '1', cidadeUf: null, ramo: null, ticketFaixa: 100, familias: [],
      });
      const perfil = perfilPorLift(melhores, []);
      expect(perfil.nMelhores).toBe(7);
    });
  });
});
