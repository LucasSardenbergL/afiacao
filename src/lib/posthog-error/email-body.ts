import type { IssueInfo } from './parse-webhook';
import { stripQueryString } from './sanitize-route';

export interface ErroAppAlerta {
  titulo: string;
  mensagem: string;
  metadata: Record<string, unknown>;
}

/**
 * Monta o alerta PII-safe. NUNCA inclui stack, person, e-mail, query string ou
 * valores de cliente — o fornecedor_alerta é lido por employee no AlertaDrawer
 * e vai pro Gmail. O detalhe sensível fica no PostHog (login-gated), via issueUrl.
 */
export function buildErroAppAlerta(info: IssueInfo): ErroAppAlerta {
  const name = (info.name ?? 'Erro desconhecido').slice(0, 200);
  const msg = (info.message ?? '').slice(0, 500);
  const rota = info.rota ? stripQueryString(info.rota).slice(0, 200) : null;

  const linhas: string[] = [];
  if (msg) linhas.push(msg);
  if (rota) linhas.push(`Rota: ${rota}`);
  if (info.issueUrl) linhas.push(`Ver no PostHog (stack + replay): ${info.issueUrl}`);

  const metadata: Record<string, unknown> = { erro: name };
  if (rota) metadata.rota = rota;
  if (info.firstSeen) metadata.primeira_vez = info.firstSeen;

  return {
    titulo: `Erro no app: ${name}`,
    mensagem: linhas.join('\n') || '(sem detalhes — ver no PostHog)',
    metadata,
  };
}
