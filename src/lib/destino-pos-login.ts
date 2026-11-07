/**
 * Para onde o login leva (Radar pacote F, achado 1). O `ProtectedRoute` manda quem não tem sessão para `/auth` com o
 * destino em DOIS lugares — `?next=` (sobrevive a recarregar a aba e é o que o consent OAuth do MCP já usa) e
 * `state.from` (o `Location` do react-router). Antes o `/auth` só lia `?next=`, e o `ProtectedRoute` só gravava o
 * `state`: quem clicava no link do e-mail do Radar sem sessão caía na home, não na ficha.
 *
 * Só caminho INTERNO passa (open redirect): nada de URL absoluta, `//host`, `/\host` (o navegador lê `\` como `/`),
 * espaço/controle no começo, nem volta para o próprio `/auth` (laço). O que não passa vira `/`.
 */

const ORIGEM_FICTICIA = 'https://interno.invalid';

/** Normaliza um candidato a destino; `null` = não é caminho interno seguro. */
export function caminhoInternoSeguro(bruto: unknown): string | null {
  if (typeof bruto !== 'string' || bruto === '') return null;
  // Precisa começar com UMA barra e nada que o navegador reinterprete como autoridade.
  if (!bruto.startsWith('/') || bruto.startsWith('//') || bruto.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex -- é exatamente o que barramos
  if (/[\u0000-\u001f\u007f]/.test(bruto)) return null;
  let url: URL;
  try {
    url = new URL(bruto, ORIGEM_FICTICIA);
  } catch {
    return null;
  }
  if (url.origin !== ORIGEM_FICTICIA) return null;
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** O `Location` que o `ProtectedRoute` põe em `state.from` → caminho. */
function caminhoDoState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('from' in state)) return null;
  const from = (state as { from: unknown }).from;
  if (typeof from === 'string') return caminhoInternoSeguro(from);
  if (typeof from !== 'object' || from === null) return null;
  const { pathname, search, hash } = from as { pathname?: unknown; search?: unknown; hash?: unknown };
  if (typeof pathname !== 'string') return null;
  const s = typeof search === 'string' ? search : '';
  const h = typeof hash === 'string' ? hash : '';
  return caminhoInternoSeguro(`${pathname}${s}${h}`);
}

/**
 * Destino pós-login. `?next=` vence (é explícito na URL e é o contrato do consent OAuth); sem ele (ou inválido),
 * `state.from`; sem nenhum, a home.
 */
export function destinoPosLogin(next: string | null, state: unknown): string {
  return caminhoInternoSeguro(next) ?? caminhoDoState(state) ?? '/';
}

/** `/auth` com o destino em `?next=` — para quem manda ao login sem sessão. Home não precisa de `next`. */
export function rotaDeLogin(destino: string): string {
  const seguro = caminhoInternoSeguro(destino);
  return seguro && seguro !== '/' ? `/auth?next=${encodeURIComponent(seguro)}` : '/auth';
}
