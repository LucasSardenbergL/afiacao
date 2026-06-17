import { describe, it, expect } from 'vitest';
import { buildListaUrl } from '../lista-url';

describe('buildListaUrl', () => {
  // A issue_url real do PostHog é .../project/{id}/error_tracking/{uuid} — NÃO tem /issues/.
  it('deriva a LISTA cortando /error_tracking/{uuid} → /error_tracking', () => {
    expect(
      buildListaUrl(
        'https://us.posthog.com/project/423408/error_tracking/0198abcd-1234-7890-abcd-ef0123456789',
      ),
    ).toBe('https://us.posthog.com/project/423408/error_tracking');
  });

  it('preserva /project/{id} (não corta cedo demais)', () => {
    expect(buildListaUrl('https://us.posthog.com/project/423408/error_tracking/x')).toContain(
      '/project/423408/error_tracking',
    );
  });

  it('idempotente: já sendo a lista, não altera', () => {
    expect(buildListaUrl('https://us.posthog.com/project/423408/error_tracking')).toBe(
      'https://us.posthog.com/project/423408/error_tracking',
    );
  });

  it('issueUrl null/undefined/vazia → host conhecido', () => {
    expect(buildListaUrl(null)).toBe('https://us.posthog.com');
    expect(buildListaUrl(undefined)).toBe('https://us.posthog.com');
    expect(buildListaUrl('')).toBe('https://us.posthog.com');
  });
});
