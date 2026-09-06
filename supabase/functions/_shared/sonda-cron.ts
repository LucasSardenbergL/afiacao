// Sonda de deploy POR CRON, fail-closed no bundle velho — o lado das EDGES.
//
// Spec: `docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md` (v5, aprovada em
// 3 rodadas de challenge adversário). Plano: `docs/superpowers/plans/2026-09-05-sonda-por-cron-f1-*`.
//
// ## Por que OPTIONS, e não um header novo num POST
//
// A sonda de hoje (`{"probe":true}` por POST) é HUMANA de propósito: um cron que a disparasse
// executaria o FLUXO REAL em todo bundle que não conhece o classificador — a `monthly-report`
// pré-sensor manda e-mail para 5.276 perfis. A primeira tentativa de conserto foi uma credencial
// nova num header de POST, apostando que o bundle velho a leria como "request não autenticado" e
// pararia no gate. É FALSO, e foi MEDIDO: `monthly-report@ef08dddd2` e `calculate-scores@45a80118b`
// não autenticam nada — executam o fluxo real para qualquer POST (2 e 11 efeitos contados no
// harness). Nenhuma credencial protege quem não pede credencial.
//
// O `OPTIONS` sai desse ciclo por ESTRUTURA: é a primeira instrução do handler em todo template
// Supabase, antes do gate de auth, antes de ler o corpo, antes de qualquer IO — e já era assim
// antes de o sensor existir. Bundle velho responde o CORS de sempre e não executa nada. Isso não é
// suposto: `bun run sonda:cron-prova` EXECUTA cada closure histórico de cada edge da allowlist com
// este request e conta o efeito, com controle positivo mostrando que o contador enxerga o fluxo
// real daquele mesmo bundle.
//
// ## Por que uma chave DEDICADA (SONDA_HMAC_KEY), e não o CRON_SECRET
//
// A credencial é observável por quem receber a requisição. Derivá-la do `CRON_SECRET` faria dela um
// verificador offline desse segredo (achado do challenge). `SONDA_HMAC_KEY` vive só nos secrets das
// edges, não autoriza NADA além de responder `{versao, edge, fonte}`, e é por edge — credencial
// vazada de uma edge não sonda outra.
import type { criarRespostaSonda } from "./sonda-versao.ts";

export const HEADER_SONDA = "x-sonda-credencial" as const;
export const METODO_SONDA = "OPTIONS" as const;
export const MENSAGEM_SONDA_PREFIXO = "sonda-de-versao:v1:" as const;
export const ENV_CHAVE_SONDA = "SONDA_HMAC_KEY" as const;
/**
 * Piso de FORMA da chave (32 bytes). Não prova entropia — isso vem do procedimento de geração
 * (`openssl rand -base64 32`, documentado no handoff). O piso existe para que uma env preenchida
 * com lixo curto ("x", "trocar") não passe por chave: aí a sonda deixa de responder, que é o lado
 * seguro (o cron fica em silêncio e o CLI acusa), em vez de atestar sob uma chave adivinhável.
 */
export const TAMANHO_MIN_CHAVE_BYTES = 32;
/** Teto do corpo que o relé aceita repassar como atestação. Corpo grande não é nossa forma. */
export const TAMANHO_MAX_CORPO_ATESTACAO = 4096;

export type CorpoSonda = ReturnType<ReturnType<typeof criarRespostaSonda>>;

export type ClasseResposta =
  | "atestou"
  | "cors-sem-sonda"
  | "contrato-invalido"
  | "identidade-divergente"
  | "redirect"
  | "timeout"
  | "erro-http";

const enc = new TextEncoder();

/** `Deno.env.get` protegido: ambiente ilegível (sandbox de teste) é ausência de chave, não crash. */
export function lerChaveDoAmbiente(): string | undefined {
  try {
    return Deno.env.get(ENV_CHAVE_SONDA);
  } catch {
    return undefined;
  }
}

/** Bytes efetivos da chave: base64 quando ela é base64 (o formato do `openssl rand -base64`). */
function bytesDaChave(chave: string): number {
  try {
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(chave)) return atob(chave).length;
  } catch {
    // não era base64 válido: cai no comprimento UTF-8 abaixo
  }
  return enc.encode(chave).length;
}

export function chaveUtilizavel(chave: string | undefined): chave is string {
  return typeof chave === "string" && chave.length > 0 && bytesDaChave(chave) >= TAMANHO_MIN_CHAVE_BYTES;
}

async function chaveHmac(chave: string, usos: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(chave), { name: "HMAC", hash: "SHA-256" }, false, usos);
}

/** A credencial que o RELÉ envia. Hex minúsculo de HMAC-SHA256(chave, "sonda-de-versao:v1:<edge>"). */
export async function derivarCredencial(chave: string, edge: string): Promise<string> {
  const k = await chaveHmac(chave, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(MENSAGEM_SONDA_PREFIXO + edge));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexParaBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  // `new Uint8Array(new ArrayBuffer(n))` e não `new Uint8Array(n)`: o segundo tipa como
  // `Uint8Array<ArrayBufferLike>`, que o `crypto.subtle.verify` do Deno 2.9 recusa (o buffer
  // poderia ser um SharedArrayBuffer).
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verificação em TEMPO CONSTANTE (`crypto.subtle.verify`), e não `===` sobre a string: a
 * comparação byte a byte de um MAC vaza, por tempo, quantos bytes iniciais o atacante acertou.
 * Qualquer dúvida (chave ausente, hex fora da forma, exceção) devolve `false`.
 */
export async function verificarCredencial(
  chave: string | undefined,
  edge: string,
  recebida: string | null,
): Promise<boolean> {
  if (!chave || !recebida) return false;
  const bytes = hexParaBytes(recebida.toLowerCase());
  if (!bytes) return false;
  try {
    const k = await chaveHmac(chave, ["verify"]);
    return await crypto.subtle.verify("HMAC", k, bytes, enc.encode(MENSAGEM_SONDA_PREFIXO + edge));
  } catch {
    return false;
  }
}

/**
 * O ramo da EDGE-ALVO, chamado DENTRO do bloco `OPTIONS` que a edge já tem.
 *
 * Devolve a resposta da sonda só com credencial válida para ESTA edge (a identidade sai do próprio
 * `respostaSonda`, não de um parâmetro que alguém possa passar errado). Em qualquer outra situação
 * devolve `null`, e a edge segue devolvendo a `Response` de CORS de sempre — *na dúvida, preflight*:
 * um 4xx aqui mudaria o CORS do app inteiro, que é o ramo mais silencioso que existe.
 *
 * Não lê o corpo, não cria client, não faz fetch. É isso que o mantém IO-free em todo bundle.
 */
export async function atenderSondaOptions(
  req: Request,
  respostaSonda: (versao: string) => CorpoSonda,
  versao: string,
  chave?: string,
): Promise<Response | null> {
  try {
    if (req.method !== METODO_SONDA) return null;
    const recebida = req.headers.get(HEADER_SONDA);
    // A env é lida DENTRO do try, e não como default de parâmetro: default é avaliado antes do
    // corpo, então uma leitura que lance (sandbox do `deno test` sem `--allow-env` — e o
    // `test:edges` roda assim de propósito) escaparia do catch e derrubaria a edge no ramo mais
    // silencioso que existe. Aqui, ambiente ilegível vira `undefined` → CORS de sempre.
    const efetiva = chave ?? lerChaveDoAmbiente();
    if (recebida === null || !chaveUtilizavel(efetiva)) return null;
    const corpo = respostaSonda(versao);
    if (!(await verificarCredencial(efetiva, corpo.edge, recebida))) return null;
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return null;
  }
}

/**
 * O request que o RELÉ envia à alvo — a ÚNICA forma de construí-lo.
 *
 * Sem parâmetro de método de propósito: o bug catastrófico deste mecanismo é o relé mandar um POST
 * (num bundle sem gate, POST é o fluxo real), e um parâmetro seria a porta desse bug. `redirect:
 * "manual"` também é estrutural: com o default, um `303` faria o `fetch` repetir a requisição como
 * `GET` na URL do Location — medido no Deno 2.9.2 — e `GET` num bundle velho é o fluxo real.
 */
export function montarRequestSonda(baseUrl: string, alvo: string, credencial: string): Request {
  const url = new URL(`/functions/v1/${alvo}`, baseUrl);
  return new Request(url.toString(), {
    method: METODO_SONDA,
    headers: { [HEADER_SONDA]: credencial },
    body: null,
    redirect: "manual",
  });
}

/**
 * Segunda barreira, avaliada em RUNTIME imediatamente antes do único `fetch` do relé.
 *
 * `montarRequestSonda` já garante a forma; esta função a RECONFERE no objeto que vai sair, porque
 * entre a construção e a chamada pode haver refactor, wrapper ou um `Request` remontado. Devolve a
 * mensagem da violação (para o corpo do 500) ou `null`.
 */
export function barreiraSaida(
  req: Request,
  baseUrl: string,
  alvo: string,
  allowlist: ReadonlySet<string>,
): string | null {
  if (!allowlist.has(alvo)) return `alvo fora da allowlist: ${alvo}`;
  if (req.method !== METODO_SONDA) return `método ${req.method} — só OPTIONS sai do relé`;
  const chaves = [...req.headers.keys()];
  if (chaves.length !== 1 || chaves[0] !== HEADER_SONDA) {
    return `header inesperado no request de saída: ${chaves.join(",")}`;
  }
  if (req.body !== null) return "corpo não nulo no request de saída";
  if (req.redirect !== "manual") return `redirect ${req.redirect} — tem de ser manual`;
  let u: URL;
  let base: URL;
  try {
    u = new URL(req.url);
    base = new URL(baseUrl);
  } catch {
    return `URL inválida no request de saída: ${req.url}`;
  }
  if (u.origin !== base.origin) return `origem ${u.origin} ≠ ${base.origin}`;
  if (u.pathname !== `/functions/v1/${alvo}`) return `pathname ${u.pathname} ≠ /functions/v1/${alvo}`;
  return null;
}

/**
 * O contrato COMPLETO da atestação, conferido pelo relé ANTES de repassar o corpo verbatim.
 *
 * É o mesmo contrato que `deploy_atestacoes_janela_viva()` exige no banco: se o relé aceitasse algo
 * mais fraco (sem `ok`, sem `fonte`), repassaria um corpo que o ledger classificaria de outro jeito
 * — e o veredito de deploy sairia de uma resposta que ninguém validou.
 */
export function classificarRespostaAlvo(
  alvo: string,
  status: number,
  contentType: string | null,
  texto: string,
): { classe: ClasseResposta; corpo?: string } {
  if (status >= 300 && status < 400) return { classe: "redirect" };
  if (status !== 200) return { classe: "erro-http" };
  const ehJson = (contentType ?? "").toLowerCase().includes("json");
  if (!ehJson || texto.trim() === "") return { classe: "cors-sem-sonda" };
  if (texto.length > TAMANHO_MAX_CORPO_ATESTACAO) return { classe: "contrato-invalido" };
  let j: unknown;
  try {
    j = JSON.parse(texto);
  } catch {
    return { classe: "contrato-invalido" };
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return { classe: "contrato-invalido" };
  const o = j as Record<string, unknown>;
  const fonteOk = typeof o.fonte === "string" &&
    (/^[0-9a-f]{64}$/.test(o.fonte) || o.fonte === "nao-mapeada");
  const versaoOk = typeof o.versao === "string" && o.versao.length >= 1 && o.versao.length <= 120;
  if (o.ok !== true || o.probe !== true || !versaoOk || !fonteOk || typeof o.edge !== "string") {
    return { classe: "contrato-invalido" };
  }
  if (o.edge !== alvo) return { classe: "identidade-divergente" };
  return { classe: "atestou", corpo: texto };
}
