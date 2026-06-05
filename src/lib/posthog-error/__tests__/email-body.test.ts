import { describe, it, expect } from 'vitest';
import { buildErroAppAlerta } from '../email-body';

describe('buildErroAppAlerta', () => {
  it('monta titulo/mensagem/metadata com os campos seguros', () => {
    const out = buildErroAppAlerta({
      issueId: 'i9', name: 'TypeError', message: "Cannot read 'map' of undefined",
      issueUrl: 'https://us.posthog.com/i/9', firstSeen: '2026-06-04T10:00:00Z',
      action: 'created', projectId: 'p', rota: '/clientes/1?cpf=9',
    });
    expect(out.titulo).toBe('Erro no app: TypeError');
    expect(out.mensagem).toContain("Cannot read 'map' of undefined");
    expect(out.mensagem).toContain('Rota: /clientes/1');
    expect(out.mensagem).not.toContain('cpf=9');
    expect(out.mensagem).toContain('https://us.posthog.com/i/9');
    expect(out.metadata.erro).toBe('TypeError');
    expect(out.metadata.rota).toBe('/clientes/1');
  });
  it('campos null → omitidos, sem quebrar', () => {
    const out = buildErroAppAlerta({
      issueId: null, name: null, message: null, issueUrl: null,
      firstSeen: null, action: null, projectId: null, rota: null,
    });
    expect(out.titulo).toBe('Erro no app: Erro desconhecido');
    expect(out.mensagem.length).toBeGreaterThan(0);
    expect(out.metadata.erro).toBe('Erro desconhecido');
  });
  it('PII-safe: metadata só tem chaves técnicas seguras', () => {
    const out = buildErroAppAlerta({
      issueId: 'i', name: 'E', message: 'm', issueUrl: 'u',
      firstSeen: null, action: 'created', projectId: 'p', rota: '/x',
    });
    const keys = Object.keys(out.metadata);
    expect(keys.every((k) => ['erro', 'rota', 'primeira_vez'].includes(k))).toBe(true);
  });
});
