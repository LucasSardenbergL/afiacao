export interface IssueInfo {
  issueId: string | null;
  name: string | null;
  message: string | null;
  issueUrl: string | null;
  firstSeen: string | null;
  action: string | null;
  projectId: string | null;
  /** best-effort: rota de uma ocorrência de exemplo, se o payload trouxer. Pode ser null no alerta issue-level. */
  rota?: string | null;
}

const pickStr = (...vals: unknown[]): string | null => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
};

/**
 * Parser DEFENSIVO do webhook de alerta do PostHog Error Tracking.
 * O JSON exato é incerto → tenta caminhos comuns, nunca lança, e NÃO extrai PII
 * (stack/person/email/properties ficam de fora por construção — só campos do issue).
 */
export function parsePosthogIssuePayload(raw: unknown): IssueInfo {
  const r: Record<string, unknown> = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const asObj = (v: unknown): Record<string, unknown> =>
    (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : {};
  const data = asObj(r.data);
  const issue = asObj(r.issue ?? data.issue ?? data);

  return {
    issueId: pickStr(issue.id, r.issue_id, issue.fingerprint, r.id),
    name: pickStr(issue.name, issue.title, issue.exception_type, r.name),
    message: pickStr(issue.description, issue.message, issue.exception_message, r.message),
    issueUrl: pickStr(issue.url, issue.link, r.url, r.issue_url),
    firstSeen: pickStr(issue.first_seen, (issue as Record<string, unknown>).firstSeen, r.first_seen),
    action: pickStr(r.action, r.event, issue.status),
    projectId: pickStr(r.project_id, asObj(r.project).id, issue.project_id),
    rota: pickStr((asObj(r.properties) as Record<string, unknown>)['$pathname'], (asObj(r.properties) as Record<string, unknown>)['$current_url']),
  };
}
