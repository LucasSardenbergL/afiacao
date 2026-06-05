// src/lib/reposicao/__tests__/param-auto-helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
  passaValidacao, disparaFusivel, fingerprintMaterial, pinBloqueia,
  impactoSimulado, decideStatus, type SugestaoParam, type LimiaresFusivel,
} from '@/lib/reposicao/param-auto-helpers';

const LIM: LimiaresFusivel = { mult: 3 };
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

describe('disparaFusivel (só multiplicador, material + upward-only)', () => {
  it('não segura mudança normal', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 150 }, LIM).segurado).toBe(false);
  });
  it('segura salto > 3x do anterior', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 301 }, LIM).segurado).toBe(true);
  });
  it('NÃO segura por cobertura (gatilho removido): demanda baixa + máx ≤ 3× passa', () => {
    // máx 200 ≤ 3×100 → não segura, mesmo que 200/1=200d de cobertura (antes seguraria).
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 200 }, LIM).segurado).toBe(false);
  });
  it('QUEDA do máximo nunca é segurada (assimétrico)', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 4 }, LIM).segurado).toBe(false);
  });
  it('sem anterior não dispara (não há base pra medir o salto)', () => {
    expect(disparaFusivel(null, { ...ok, estoque_maximo: 9999 }, LIM).segurado).toBe(false);
  });
  it('máx_antes <= 0 não dispara (não há base)', () => {
    expect(disparaFusivel(0, { ...ok, estoque_maximo: 9999 }, LIM).segurado).toBe(false);
  });
  it('material: 3× exato NÃO segura (precisa > mult, arredondado)', () => {
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 300 }, LIM).segurado).toBe(false);
    expect(disparaFusivel(100, { ...ok, estoque_maximo: 301 }, LIM).segurado).toBe(true);
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

describe('decideStatus (precedência: NULL → validação → base → pin → no-op → fusível → aplicado)', () => {
  it('bloqueado_validacao vence tudo', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok, estoque_maximo: 10 }, pin: null, limiares: LIM })).toBe('bloqueado_validacao');
  });
  it('sem base válida (max_antes NULL) + sugestão OK → bloqueado_validacao (cold-start é manual)', () => {
    expect(decideStatus({ antes: { ...ok, estoque_maximo: null }, sugestao: ok, pin: null, limiares: LIM })).toBe('bloqueado_validacao');
  });
  it('sem base válida (max_antes <= 0) → bloqueado_validacao', () => {
    expect(decideStatus({ antes: { ...ok, estoque_maximo: 0 }, sugestao: ok, pin: null, limiares: LIM })).toBe('bloqueado_validacao');
  });
  it('segurado vence aplicado quando salta > 3×', () => {
    expect(decideStatus({ antes: { ...ok, estoque_maximo: 100 }, sugestao: { ...ok, estoque_maximo: 400 }, pin: null, limiares: LIM })).toBe('segurado');
  });
  it('pin vence o fusível (pin bate mesmo com salto > 3×) → pinado', () => {
    expect(decideStatus({ antes: { ...ok, estoque_maximo: 100 }, sugestao: { ...ok, estoque_maximo: 400 }, pin: { pp: 50, max: 400 }, limiares: LIM })).toBe('pinado');
  });
  it('pinado quando sugestão == rejeitada', () => {
    expect(decideStatus({ antes: { ...ok, ponto_pedido: 40, estoque_maximo: 100 }, sugestao: { ...ok, ponto_pedido: 50, estoque_maximo: 120 }, pin: { pp: 50, max: 120 }, limiares: LIM })).toBe('pinado');
  });
  it('aplicado quando difere do atual e do rejeitado', () => {
    expect(decideStatus({ antes: { ...ok, ponto_pedido: 40, estoque_maximo: 100 }, sugestao: ok, pin: { pp: 50, max: 999 }, limiares: LIM })).toBe('aplicado');
  });
  it('sem_mudanca quando igual ao atual (arredondado)', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok }, pin: null, limiares: LIM })).toBe('sem_mudanca');
  });
  it('no-op vence o fusível: sugestão == atual NÃO é falso segurado (cobertura alta era o bug)', () => {
    // máx 200 igual ao atual 200 (giro lento: demanda baixa, máx dominado por SS) → sem_mudanca, não segurado.
    const slow = { ...ok, ponto_pedido: 30, estoque_maximo: 200 };
    expect(decideStatus({ antes: slow, sugestao: { ...slow }, pin: null, limiares: LIM })).toBe('sem_mudanca');
  });
  it('giro lento com máx pequeno inalterado → sem_mudanca (prova que cobertura não dispara)', () => {
    const slow = { ...ok, estoque_minimo: 5, ponto_pedido: 10, estoque_maximo: 30 };
    expect(decideStatus({ antes: slow, sugestao: { ...slow }, pin: null, limiares: LIM })).toBe('sem_mudanca');
  });
  it('QUEDA do máximo (100→4) → aplicado (não segurado: fusível é upward-only)', () => {
    expect(decideStatus({ antes: { ...ok, ponto_pedido: 3, estoque_maximo: 100 }, sugestao: { ...ok, ponto_pedido: 2, estoque_minimo: 1, estoque_maximo: 4 }, pin: null, limiares: LIM })).toBe('aplicado');
  });
  it('salto 3× upward ainda → segurado', () => {
    expect(decideStatus({ antes: { ...ok, estoque_maximo: 100 }, sugestao: { ...ok, estoque_maximo: 301 }, pin: null, limiares: LIM })).toBe('segurado');
  });
  it('sem_mudanca quando a sugestão tem campo NULL (status != OK → mantém anterior)', () => {
    expect(decideStatus({ antes: ok, sugestao: { ...ok, estoque_maximo: null }, pin: null, limiares: LIM })).toBe('sem_mudanca');
  });
});
