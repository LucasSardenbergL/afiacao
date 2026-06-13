/**
 * Contrato do push da vendedora — validação do request da edge `enviar-push`
 * e montagem do JSON que o service worker (`public/push-sw.js`) consome.
 *
 * ⚠️ ESPELHADO VERBATIM em `supabase/functions/enviar-push/index.ts` (Deno não
 * importa do src/). Este arquivo é o oráculo TDD; mudou aqui → re-espelhar lá.
 */

const TITULO_MAX = 120;
const CORPO_MAX = 240;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnvioPushValido {
  user_ids: string[];
  titulo: string;
  corpo: string;
  /** Path interno (começa com '/' e não '//') — o SW abre na própria origem. */
  url: string;
  /** Agrupa/substitui notificações no device (ex.: 'wa-<conversa>'). */
  tag?: string;
}

export type ResultadoValidacao =
  | { ok: true; dados: EnvioPushValido }
  | { ok: false; erro: string };

/** Valida o body recebido pela edge. Defaults seguros; nunca lança. */
export function validarEnvioPush(body: unknown): ResultadoValidacao {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!Array.isArray(b.user_ids) || b.user_ids.length === 0) {
    return { ok: false, erro: 'user_ids deve ser array não-vazio' };
  }
  const userIds = [...new Set(b.user_ids.map(String))];
  if (userIds.some((id) => !UUID_RE.test(id))) {
    return { ok: false, erro: 'user_ids contém valor que não é uuid' };
  }

  const titulo = typeof b.titulo === 'string' ? b.titulo.trim() : '';
  if (!titulo) return { ok: false, erro: 'titulo é obrigatório' };

  const corpo = typeof b.corpo === 'string' ? b.corpo.trim() : '';

  const urlCrua = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : '/';
  // Só path interno: o notificationclick abre na própria origem. '//host' é
  // protocol-relative (vira externo) — rejeitar junto com http(s) absolutos.
  if (!urlCrua.startsWith('/') || urlCrua.startsWith('//')) {
    return { ok: false, erro: 'url deve ser path interno (começar com /)' };
  }

  const tag = typeof b.tag === 'string' && b.tag.trim() ? b.tag.trim() : undefined;

  return {
    ok: true,
    dados: {
      user_ids: userIds,
      titulo: titulo.slice(0, TITULO_MAX),
      corpo: corpo.slice(0, CORPO_MAX),
      url: urlCrua,
      tag,
    },
  };
}

/** JSON entregue ao SW via web-push (o handler `push` lê estes 4 campos). */
export function montarNotificacao(dados: EnvioPushValido): {
  titulo: string;
  corpo: string;
  url: string;
  tag?: string;
} {
  return { titulo: dados.titulo, corpo: dados.corpo, url: dados.url, tag: dados.tag };
}
