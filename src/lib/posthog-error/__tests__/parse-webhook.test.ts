import { describe, it, expect } from 'vitest';
import { parsePosthogIssuePayload } from '../parse-webhook';

describe('parsePosthogIssuePayload', () => {
  it('extrai de um shape com issue aninhada', () => {
    const r = parsePosthogIssuePayload({
      action: 'created',
      project_id: 'proj1',
      issue: { id: 'iss9', name: 'TypeError', description: 'x is undefined', url: 'https://us.posthog.com/i/9', first_seen: '2026-06-04T10:00:00Z' },
    });
    expect(r.issueId).toBe('iss9');
    expect(r.name).toBe('TypeError');
    expect(r.message).toBe('x is undefined');
    expect(r.issueUrl).toBe('https://us.posthog.com/i/9');
    expect(r.action).toBe('created');
    expect(r.projectId).toBe('proj1');
  });
  it('objeto vazio → tudo null, sem lançar', () => {
    const r = parsePosthogIssuePayload({});
    expect(r.issueId).toBeNull();
    expect(r.name).toBeNull();
  });
  it('raw não-objeto (string/null/number) → tudo null, sem lançar', () => {
    expect(() => parsePosthogIssuePayload('lixo' as unknown)).not.toThrow();
    expect(parsePosthogIssuePayload(null as unknown).issueId).toBeNull();
    expect(parsePosthogIssuePayload(42 as unknown).name).toBeNull();
  });
  it('NÃO vaza PII: stack/person/email do payload não entram no IssueInfo', () => {
    const r = parsePosthogIssuePayload({
      issue: { id: 'i', name: 'Err', stack: 'at Foo (/secret/path.ts:1)', exception_list: [{ stacktrace: 'x' }] },
      person: { email: 'cliente@empresa.com', properties: { cpf: '123' } },
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('cliente@empresa.com');
    expect(json).not.toContain('123');
    expect(json).not.toContain('stacktrace');
  });
  it('tenta caminhos alternativos (data.issue, title, message)', () => {
    const r = parsePosthogIssuePayload({ data: { issue: { fingerprint: 'fp1', title: 'Boom', message: 'kaboom' } } });
    expect(r.issueId).toBe('fp1');
    expect(r.name).toBe('Boom');
    expect(r.message).toBe('kaboom');
  });
});
