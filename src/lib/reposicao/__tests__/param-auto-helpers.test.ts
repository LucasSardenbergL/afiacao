// src/lib/reposicao/__tests__/param-auto-helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
  passaValidacao, disparaFusivel, fingerprintMaterial, pinBloqueia,
  impactoSimulado, decideStatus, type SugestaoParam, type LimiaresFusivel,
} from '@/lib/reposicao/param-auto-helpers';

const LIM: LimiaresFusivel = { mult: 3, coberturaDias: 120 };
const ok: SugestaoParam = { ponto_pedido: 50, estoque_minimo: 20, estoque_maximo: 120, estoque_seguranca: 15, cobertura_alvo_dias: 30 };

describe('passaValidacao', () => {
  it('aceita sugestão coerente', () => { expect(passaValidacao(ok).ok).toBe(true); });
  it('rejeita campo nulo', () => { expect(passaValidacao({ ...ok, estoque_maximo: null }).ok).toBe(false); });
  it('rejeita não-finito', () => { expect(passaValidacao({ ...ok, ponto_pedido: Number.NaN }).ok).toBe(false); });
  it('rejeita negativo', () => { expect(passaValidacao({ ...ok, estoque_minimo: -1 }).ok).toBe(false); });
  it('rejeita max < pp', () => { expect(passaValidacao({ ...ok, estoque_maximo: 40 }).ok).toBe(false); });
  it('rejeita pp < min', () => { expect(passaValidacao({ ...ok, ponto_pedido: 10 }).ok).toBe(false); });
  it('rejeita cobertura <= 0', () => { expect(passaValidacao({ ...ok, cobertura_alvo_dias: 0 }).ok).toBe(false); });
});

describe('disparaFusivel', () => {
  it('não segura mudança normal', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 150 }, 4, LIM).segurado).toBe(false);
  });
  it('segura salto > 3x do anterior', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 301 }, 4, LIM).segurado).toBe(true);
  });
  it('segura cobertura implícita > 120 dias', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 200 }, 1, LIM).segurado).toBe(true);
  });
  it('sem anterior não dispara por multiplicador (mas dispara por cobertura)', () => {
    expect(disparaFusivel(null, { ...ok, estoque_maximo: 9999 }, 100, LIM).segurado).toBe(false);
    expect(disparaFusivel(null, { ...ok, estoque_maximo: 9999 }, 1, LIM).segurado).toBe(true);
  });
  it('demanda nula não divide por zero', () => {
    expect(() => disparaFusivel(100, { ...ok, estoque_maximo: 150 }, null, LIM)).not.toThrow();
  });
});

describe('fingerprintMaterial / pinBloqueia', () => {
  it('fingerprint arredonda pp+max', () => {
    expect(fingerprintMaterial(50.4, 120.6)).toBe('50|121');
  });
  it('pin bloqueia quando pp+max iguais (arredondados)', () => {
    expect(pinBloqueia(50, 120, { ...ok, ponto_pedido: 50.2, estoque_maximo: 119.8 })).toBe(true);
  });
  it('pin libera quando pp ou max muda materialmente', () => {
    expect(pinBloqueia(50, 120, { ...ok, ponto_pedido: 60, estoque_maximo: 120 })).toBe(false);
  });
});

describe('impactoSimulado', () => {
  it('Δ qtde × custo quando posição <= pp', () => {
    const r = impactoSimulado({ ppAntes: 50, maxAntes: 120, ppDepois: 50, maxDepois: 150, posicao: 40, custo: 5 });
    expect(r.qtdeAntes).toBe(80); expect(r.qtdeDepois).toBe(110); expect(r.impactoRs).toBe(150);
  });
  it('qtde 0 quando posição > pp', () => {
    const r = impactoSimulado({ ppAntes: 50, maxAntes: 120, ppDepois: 50, maxDepois: 150, posicao: 60, custo: 5 });
    expect(r.qtdeAntes).toBe(0); expect(r.qtdeDepois).toBe(0); expect(r.impactoRs).toBe(0);
  });
  it('custo nulo → impacto desconhecido (null), não zero', () => {
    const r = impactoSimulado({ ppAntes: 50, maxAntes: 120, ppDepois: 50, maxDepois: 150, posicao: 40, custo: null });
    expect(r.impactoRs).toBeNull();
  });
});

describe('decideStatus (precedência validação → fusível → pin → aplicado)', () => {
  it('bloqueado_validacao vence tudo', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok, estoque_maximo: 10 }, demandaMediaDiaria: 4, pin: null, limiares: LIM })).toBe('bloqueado_validacao');
  });
  it('segurado vence pin e aplicado', () => {
    expect(decideStatus({ antes: { ...ok, estoque_maximo: 100 }, sugestao: { ...ok, estoque_maximo: 400 }, demandaMediaDiaria: 4, pin: { pp: 50, max: 400 }, limiares: LIM })).toBe('segurado');
  });
  it('pinado quando sugestão == rejeitada', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok, ponto_pedido: 50, estoque_maximo: 120 }, demandaMediaDiaria: 4, pin: { pp: 50, max: 120 }, limiares: LIM })).toBe('pinado');
  });
  it('aplicado quando difere do atual e do rejeitado', () => {
    expect(decideStatus({ antes: { ...ok, ponto_pedido: 40, estoque_maximo: 100 }, sugestao: ok, demandaMediaDiaria: 4, pin: { pp: 50, max: 999 }, limiares: LIM })).toBe('aplicado');
  });
  it('sem_mudanca quando igual ao atual (arredondado)', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok }, demandaMediaDiaria: 4, pin: null, limiares: LIM })).toBe('sem_mudanca');
  });
  it('sem_mudanca quando a sugestão tem campo NULL (status != OK → mantém anterior)', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok, estoque_maximo: null }, demandaMediaDiaria: 4, pin: null, limiares: LIM })).toBe('sem_mudanca');
  });
});
