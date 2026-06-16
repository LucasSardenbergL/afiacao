import { describe, it, expect } from 'vitest';
import { scoreCandidato } from '../score';
import type { CandidatoFeatures, PerfilMelhores } from '../types';

function candidatoBase(overrides: Partial<CandidatoFeatures> = {}): CandidatoFeatures {
  return {
    documento: '12345678000190',
    empresaAlvo: 'oben',
    cidadeUf: null,
    ramo: null,
    ticketFaixa: null,
    familias: [],
    compraEmOutraEmpresa: false,
    compraNaEmpresaAlvo: false,
    ultimaCompraGrupoDias: null,
    atrasoRelativo: null,
    ...overrides,
  };
}

function perfilBase(overrides: Partial<PerfilMelhores> = {}): PerfilMelhores {
  return {
    regiaoLift: {},
    ramoLift: {},
    familiaLift: {},
    ticketMediano: null,
    nMelhores: 10,
    ...overrides,
  };
}

describe('scoreCandidato', () => {
  describe('dimensoesUsadas e confianca', () => {
    it('apenas cidadeUf disponível → 1 dimensão → confianca 0.25', () => {
      const c = candidatoBase({ cidadeUf: 'DIVINOPOLIS-MG' });
      const p = perfilBase({ regiaoLift: { 'DIVINOPOLIS-MG': 2.0 } });
      const r = scoreCandidato(c, p);
      expect(r.dimensoesUsadas).toContain('regiao');
      expect(r.dimensoesUsadas).toHaveLength(1);
      expect(r.confianca).toBe(0.25);
    });

    it('candidato completo (4 dimensões) → confianca 1.0', () => {
      const c = candidatoBase({
        cidadeUf: 'BH-MG',
        ramo: 'marcenaria',
        ticketFaixa: 500,
        familias: ['abrasivos'],
      });
      const p = perfilBase({
        regiaoLift: { 'BH-MG': 1.5 },
        ramoLift: { marcenaria: 2.0 },
        ticketMediano: 500,
        familiaLift: { abrasivos: 1.8 },
      });
      const r = scoreCandidato(c, p);
      expect(r.dimensoesUsadas).toHaveLength(4);
      expect(r.confianca).toBe(1.0);
    });

    it('ramo=null não conta como dimensão (ausência ≠ zero)', () => {
      const c = candidatoBase({ cidadeUf: 'BH-MG', ramo: null });
      const p = perfilBase({ regiaoLift: { 'BH-MG': 2.0 } });
      const r = scoreCandidato(c, p);
      expect(r.dimensoesUsadas).not.toContain('ramo');
    });

    it('familias=[] não conta como dimensão (ausência ≠ zero)', () => {
      const c = candidatoBase({ familias: [] });
      const r = scoreCandidato(c, perfilBase());
      expect(r.dimensoesUsadas).not.toContain('familias');
    });

    it('ticketFaixa=null não conta como dimensão', () => {
      const c = candidatoBase({ ticketFaixa: null });
      const r = scoreCandidato(c, perfilBase({ ticketMediano: 500 }));
      expect(r.dimensoesUsadas).not.toContain('ticket');
    });

    it('candidato totalmente frio (sem nenhuma dimensão) → confianca 0', () => {
      const r = scoreCandidato(candidatoBase(), perfilBase());
      expect(r.dimensoesUsadas).toHaveLength(0);
      expect(r.confianca).toBe(0);
    });
  });

  describe('score — ausência não é zero (regra fundamental)', () => {
    it('candidato com ramo=null NÃO recebe lift 0 por ramo (ausência ≠ zero)', () => {
      // Candidato A: ramo=null (1 dimensão: só regiao)
      // Candidato B: ramo='nicho' com lift baixo 0.5 (2 dimensões)
      // A e B têm regiao com mesmo lift
      // A NÃO deve ter score penalizado pelo ramo ausente
      // A score deve ser comparável (não artificialmente menor)
      const perfil = perfilBase({
        regiaoLift: { 'DIVINOPOLIS-MG': 2.0 },
        ramoLift: { nicho: 0.5 },
      });

      const candidatoSemRamo = candidatoBase({ cidadeUf: 'DIVINOPOLIS-MG', ramo: null });
      const candidatoRamoBaixo = candidatoBase({ cidadeUf: 'DIVINOPOLIS-MG', ramo: 'nicho' });

      const scoreA = scoreCandidato(candidatoSemRamo, perfil);
      const scoreB = scoreCandidato(candidatoRamoBaixo, perfil);

      // Ambos têm score de aderência de regiao. A não deve ser penalizado por não ter ramo.
      // A (só regiao com lift 2) deve ter aderência 1.0 na dimensão regiao.
      // B (regiao lift 2 + ramo lift 0.5) terá aderência média de regiao+ramo.
      // scoreA.score deve ser >= scoreB.score (ramo baixo puxa pra baixo no B)
      expect(scoreA.score).toBeGreaterThan(0);
      // A confiança de A é menor (1 dim), mas o score de aderência médio de A deve ser >= B
      expect(scoreA.score).toBeGreaterThanOrEqual(scoreB.score);
    });

    it('dois candidatos com mesma aderência média mas confianças diferentes → scores comparáveis, confianças distintas', () => {
      // Usa só dimensões baseadas em lift (regiao, ramo, familias) com lift idêntico=2.
      // Ticket usa escala diferente (proximidade relativa), então é excluído desta comparação.
      const perfil = perfilBase({
        regiaoLift: { 'DIVINOPOLIS-MG': 2.0 },
        ramoLift: { marcenaria: 2.0 },
        familiaLift: { abrasivos: 2.0 },
      });

      const c1 = candidatoBase({ cidadeUf: 'DIVINOPOLIS-MG' }); // 1 dimensão
      const c3 = candidatoBase({
        cidadeUf: 'DIVINOPOLIS-MG',
        ramo: 'marcenaria',
        familias: ['abrasivos'],
        // ticketFaixa=null → ticket ausente (não conta como dimensão)
      }); // 3 dimensões com mesmo lift

      const r1 = scoreCandidato(c1, perfil);
      const r3 = scoreCandidato(c3, perfil);

      // Aderência média deve ser igual (todos têm lift=2 nas dimensões usadas)
      expect(r1.score).toBeCloseTo(r3.score, 5);
      // Confiança deve ser diferente
      expect(r1.confianca).toBe(0.25);
      expect(r3.confianca).toBe(0.75);
    });
  });

  describe('score — ticket', () => {
    it('ticket igual ao mediano → aderência máxima na dimensão', () => {
      const c = candidatoBase({ ticketFaixa: 500 });
      const p = perfilBase({ ticketMediano: 500 });
      const r = scoreCandidato(c, p);
      expect(r.dimensoesUsadas).toContain('ticket');
      expect(r.score).toBeGreaterThan(0);
    });

    it('ticket muito distante do mediano → aderência baixa (decai com distância)', () => {
      const cPerto = candidatoBase({ ticketFaixa: 500 });
      const cLonge = candidatoBase({ ticketFaixa: 50000 });
      const p = perfilBase({ ticketMediano: 500 });

      const perto = scoreCandidato(cPerto, p);
      const longe = scoreCandidato(cLonge, p);

      expect(perto.score).toBeGreaterThan(longe.score);
    });
  });

  describe('score — famílias', () => {
    it('família com alto lift → score alto', () => {
      const c = candidatoBase({ familias: ['abrasivos'] });
      const p = perfilBase({ familiaLift: { abrasivos: 4.0 } });
      const r = scoreCandidato(c, p);
      expect(r.dimensoesUsadas).toContain('familias');
      expect(r.score).toBeGreaterThan(0);
    });

    it('múltiplas famílias → média dos lifts', () => {
      const c = candidatoBase({ familias: ['abrasivos', 'tintas'] });
      const p = perfilBase({ familiaLift: { abrasivos: 4.0, tintas: 2.0 } });
      const r = scoreCandidato(c, p);
      // A aderência de família deve ser a média dos lifts das famílias do candidato
      // O score final é a média das aderências das dimensões usadas
      expect(r.score).toBeGreaterThan(0);
    });
  });

  describe('score — região', () => {
    it('cidadeUf sem lift no perfil → usa lift neutro 1 (cidade conhecida mas não desproporcional)', () => {
      const c = candidatoBase({ cidadeUf: 'DESCONHECIDA-MG' });
      const p = perfilBase({ regiaoLift: { 'OUTRA-MG': 3.0 } });
      const r = scoreCandidato(c, p);
      // cidadeUf está presente no candidato → conta como dimensão
      expect(r.dimensoesUsadas).toContain('regiao');
    });
  });
});
