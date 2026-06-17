/**
 * Deriva a URL da LISTA de issues (Error Tracking) a partir da issueUrl de UMA issue.
 * Usada SÓ no e-mail de rollup (anti-tempestade), como link "ver todos os erros".
 *
 * O PostHog manda issue_url = https://us.posthog.com/project/{id}/error_tracking/{uuid};
 * cortamos o /{uuid} final → /error_tracking (a lista). Sem issueUrl, cai no host conhecido.
 */
export function buildListaUrl(issueUrl: string | null | undefined): string {
  if (!issueUrl) return 'https://us.posthog.com';
  return issueUrl.replace(/\/error_tracking\/.*/, '/error_tracking');
}
