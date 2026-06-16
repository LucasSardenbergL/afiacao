import { describe, it, expect } from 'vitest';
import { validarLeitura, montarPathComprovacao } from '../comprovacao';

// ---------------------------------------------------------------------------
// validarLeitura
// ---------------------------------------------------------------------------

describe('validarLeitura', () => {
  describe('valor ausente', () => {
    it('null → inválido', () => {
      const r = validarLeitura(null, null, null);
      expect(r.ok).toBe(false);
      expect(r.erro).toBeTruthy();
    });
  });

  describe('sem faixa (min e max null)', () => {
    it('qualquer número positivo → ok', () => {
      expect(validarLeitura(42, null, null)).toEqual({ ok: true, erro: null });
    });
    it('zero → ok', () => {
      expect(validarLeitura(0, null, null)).toEqual({ ok: true, erro: null });
    });
    it('negativo → ok (sem restrição)', () => {
      expect(validarLeitura(-5, null, null)).toEqual({ ok: true, erro: null });
    });
  });

  describe('só min definido', () => {
    it('valor igual ao min → ok (borda inclusiva)', () => {
      expect(validarLeitura(5, 5, null)).toEqual({ ok: true, erro: null });
    });
    it('valor acima do min → ok', () => {
      expect(validarLeitura(6, 5, null)).toEqual({ ok: true, erro: null });
    });
    it('valor abaixo do min → erro sem mencionar max', () => {
      const r = validarLeitura(3, 5, null);
      expect(r.ok).toBe(false);
      expect(r.erro).toContain('3');
      expect(r.erro).toContain('5');
      expect(r.erro).not.toContain('undefined');
      expect(r.erro).not.toContain('null');
    });
  });

  describe('só max definido', () => {
    it('valor igual ao max → ok (borda inclusiva)', () => {
      expect(validarLeitura(10, null, 10)).toEqual({ ok: true, erro: null });
    });
    it('valor abaixo do max → ok', () => {
      expect(validarLeitura(9, null, 10)).toEqual({ ok: true, erro: null });
    });
    it('valor acima do max → erro sem mencionar min', () => {
      const r = validarLeitura(11, null, 10);
      expect(r.ok).toBe(false);
      expect(r.erro).toContain('11');
      expect(r.erro).toContain('10');
      expect(r.erro).not.toContain('undefined');
      expect(r.erro).not.toContain('null');
    });
  });

  describe('faixa completa [min, max]', () => {
    it('dentro da faixa → ok', () => {
      expect(validarLeitura(7, 5, 10)).toEqual({ ok: true, erro: null });
    });
    it('no min → ok', () => {
      expect(validarLeitura(5, 5, 10)).toEqual({ ok: true, erro: null });
    });
    it('no max → ok', () => {
      expect(validarLeitura(10, 5, 10)).toEqual({ ok: true, erro: null });
    });
    it('abaixo do min → erro menciona faixa', () => {
      const r = validarLeitura(3, 5, 10);
      expect(r.ok).toBe(false);
      expect(r.erro).toContain('5');
      expect(r.erro).toContain('10');
    });
    it('acima do max → erro menciona faixa', () => {
      const r = validarLeitura(15, 5, 10);
      expect(r.ok).toBe(false);
      expect(r.erro).toContain('5');
      expect(r.erro).toContain('10');
    });
    it('faixa de ponto (min === max): valor exato → ok', () => {
      expect(validarLeitura(7, 7, 7)).toEqual({ ok: true, erro: null });
    });
    it('faixa de ponto (min === max): valor diferente → erro', () => {
      const r = validarLeitura(7.1, 7, 7);
      expect(r.ok).toBe(false);
    });
  });

  describe('decimais', () => {
    it('valor decimal dentro da faixa → ok', () => {
      expect(validarLeitura(5.5, 5.0, 6.0)).toEqual({ ok: true, erro: null });
    });
    it('valor decimal abaixo → erro', () => {
      expect(validarLeitura(4.99, 5.0, 6.0).ok).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// montarPathComprovacao
// ---------------------------------------------------------------------------

describe('montarPathComprovacao', () => {
  const UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const TAREFA_ID = '11111111-2222-3333-4444-555555555555';
  const TS = 1717200000000;

  it('formato correto: uid/tarefaId/ts.ext', () => {
    expect(montarPathComprovacao(UID, TAREFA_ID, 'jpg', TS))
      .toBe(`${UID}/${TAREFA_ID}/${TS}.jpg`);
  });

  it('inicia exatamente com uid/tarefaId (requisito do RPC)', () => {
    const path = montarPathComprovacao(UID, TAREFA_ID, 'png', TS);
    expect(path.startsWith(`${UID}/${TAREFA_ID}/`)).toBe(true);
  });

  it('extensão png preservada', () => {
    const path = montarPathComprovacao(UID, TAREFA_ID, 'png', TS);
    expect(path.endsWith('.png')).toBe(true);
  });

  it('extensão heic preservada', () => {
    const path = montarPathComprovacao(UID, TAREFA_ID, 'heic', TS);
    expect(path.endsWith('.heic')).toBe(true);
  });

  it('timestamps distintos geram paths distintos', () => {
    const p1 = montarPathComprovacao(UID, TAREFA_ID, 'jpg', 1000);
    const p2 = montarPathComprovacao(UID, TAREFA_ID, 'jpg', 2000);
    expect(p1).not.toBe(p2);
  });

  it('usuários distintos geram paths distintos', () => {
    const p1 = montarPathComprovacao('user-a', TAREFA_ID, 'jpg', TS);
    const p2 = montarPathComprovacao('user-b', TAREFA_ID, 'jpg', TS);
    expect(p1).not.toBe(p2);
  });

  it('tarefas distintas geram paths distintos', () => {
    const p1 = montarPathComprovacao(UID, 'tarefa-x', 'jpg', TS);
    const p2 = montarPathComprovacao(UID, 'tarefa-y', 'jpg', TS);
    expect(p1).not.toBe(p2);
  });
});
