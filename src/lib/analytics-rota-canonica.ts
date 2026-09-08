/**
 * Rota CANÔNICA — a chave do evento `navegacao.rota_servida` no ledger.
 *
 * Por que existe: o `PageViewTracker` manda ao PostHog `pathname + search` cru
 * (`$pageview`). Isso serve ao canal censurável, onde a cardinalidade é problema
 * de terceiro e o dado nunca sai da conta do PostHog. Não serve ao ledger: ali o
 * evento vira LINHA no nosso Postgres, então `?cliente=<uuid>` e `/pedido/<id>`
 * viram acervo nosso, com retenção nossa. Copiar o formato do `$pageview` para
 * dentro do banco seria trocar de cano sem trocar de critério.
 *
 * A pergunta que este canal responde é "QUE TELA foi servida", não "para qual
 * registro" — a segunda metade é dado de domínio, e o domínio já tem tabelas.
 * Logo a chave é a FORMA da rota, com todo segmento identificador mascarado.
 *
 * ⚠️ A máscara é FAIL-CLOSED: segmento que não se prova estático (o alfabeto
 * fechado abaixo) vira `:id`. O modo de falha aceitável é perder granularidade
 * de uma rota; o inaceitável é um e-mail, um token ou um CNPJ entrarem no
 * acervo porque alguém pôs isso num path e a heurística não previu o formato.
 */

/** Teto de segmentos. A rota mais funda do `App.tsx` tem 4. */
const MAX_SEGMENTOS = 6;

/**
 * Teto de caracteres. Casa com o `left(coalesce(p_chave,''), 100)` da RPC
 * `analytics_ledger_registrar`: cortar aqui, do mesmo jeito, mantém a chave que
 * o cliente pensa que gravou IGUAL à que o banco deduplica.
 */
const MAX_CHARS = 100;

const SO_DIGITOS = /^[0-9]+$/;
const HEX_LONGO = /^[0-9a-f]{12,}$/;

/**
 * Segmento longo é token/slug gerado muito antes de ser nome de tela: o maior
 * segmento estático do `App.tsx` tem 18 chars (`standard-processes`).
 *
 * ⚠️ Este teto é quem mascara UUID. Houve aqui uma regra `/^[0-9a-f]{8}-…$/`
 * dedicada, e a falsificação a derrubou: sabotá-la deixava a suíte VERDE,
 * porque UUID tem 36 chars (32 sem hífen) e já caía neste teto antes. Guard
 * inalcançável que parece proteger é pior que ausência — foi removido, e o
 * teste `UUID vira :id` passou a apontar para cá. Consequência a saber ao mexer
 * neste número: subi-lo acima de 32 volta a deixar UUID passar CRU, e é esse
 * teste que fica vermelho.
 */
const MAX_CHARS_SEGMENTO = 24;

/**
 * Alfabeto do que pode passar CRU. Deliberadamente estreito: letras minúsculas,
 * dígitos, `-`, `_` e `.` (o `.lovable` de `/.lovable/oauth/consent` é rota
 * real). Qualquer outra coisa — `@`, `%`, `+`, espaço, acento, `:` — cai na
 * máscara.
 */
const SEGMENTO_ESTATICO = /^[a-z0-9._-]+$/;

/** Um segmento que já parece identificador, ou que não se prova estático. */
const MASCARA = ':id';

/** Marca que a rota tinha mais segmentos do que o teto — não é uma rota real. */
const TRUNCADO = ':trunc';

function canonicalizarSegmento(seg: string): string {
  // `.` e `..` são navegação, não tela — e nunca deveriam chegar aqui.
  if (seg === '.' || seg === '..') return MASCARA;
  if (SO_DIGITOS.test(seg) || HEX_LONGO.test(seg)) return MASCARA;
  if (seg.length > MAX_CHARS_SEGMENTO) return MASCARA;
  if (!SEGMENTO_ESTATICO.test(seg)) return MASCARA;
  return seg;
}

/**
 * Reduz um `pathname` à forma da rota.
 *
 * ⚠️ Recebe `pathname`, NUNCA `pathname + search`: a querystring não é forma de
 * tela, é argumento — e é justamente onde os ids de cliente viajam.
 */
export function canonicalizarRota(pathname: string): string {
  const bruto = (pathname ?? '').trim().toLowerCase();
  // Defesa contra quem passar a URL inteira apesar do contrato acima.
  const semQuery = bruto.split('?')[0].split('#')[0];
  const segmentos = semQuery.split('/').filter((s) => s !== '');

  if (segmentos.length === 0) return '/';

  const excedeu = segmentos.length > MAX_SEGMENTOS;
  const usados = segmentos.slice(0, MAX_SEGMENTOS).map(canonicalizarSegmento);
  if (excedeu) usados.push(TRUNCADO);

  const rota = '/' + usados.join('/');
  return rota.length > MAX_CHARS ? rota.slice(0, MAX_CHARS) : rota;
}
