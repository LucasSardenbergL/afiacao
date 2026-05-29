import { describe, it, expect } from 'vitest';
import { interpretarRespostaDisparo } from '../shared';

describe('interpretarRespostaDisparo', () => {
  it('Omie direto (disparados>0) → success citando Omie', () => {
    const r = interpretarRespostaDisparo({ disparados: 1 }, 130);
    expect(r.tone).toBe('success');
    expect(r.message).toContain('#130');
    expect(r.message).toContain('Omie');
  });

  it('portal Sayerlack em background (aguardando_portal_sayerlack>0) → success, diz "iniciado" e NÃO "enviado"', () => {
    const r = interpretarRespostaDisparo({ aguardando_portal_sayerlack: 1 }, 159);
    expect(r.tone).toBe('success');
    expect(r.message).toContain('iniciado');
    // codex: no 202 ainda não é terminal — não afirmar "enviado"
    expect(r.message).not.toContain('enviado');
  });

  it('falhas>0 → error', () => {
    const r = interpretarRespostaDisparo({ falhas: 1 }, 7);
    expect(r.tone).toBe('error');
    expect(r.message).toContain('falha');
  });

  it('vazio/null → info "nada a disparar"', () => {
    expect(interpretarRespostaDisparo(null, 1).tone).toBe('info');
    expect(interpretarRespostaDisparo(undefined, 1).tone).toBe('info');
    expect(interpretarRespostaDisparo({}, 1).message).toContain('nada a disparar');
  });

  it('prioridade: disparados (Omie) ganha de aguardando/falhas', () => {
    const r = interpretarRespostaDisparo(
      { disparados: 1, aguardando_portal_sayerlack: 1, falhas: 1 },
      5,
    );
    expect(r.tone).toBe('success');
    expect(r.message).toContain('Omie');
  });

  it('aguardando ganha de falhas quando não houve disparo direto', () => {
    const r = interpretarRespostaDisparo({ aguardando_portal_sayerlack: 1, falhas: 1 }, 9);
    expect(r.tone).toBe('success');
    expect(r.message).toContain('iniciado');
  });
});
