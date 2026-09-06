# Sonda por cron fail-closed — F1 (mecanismo + relé + prova executada) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a fatia F1 da spec aprovada (`docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md`, v5): o ramo `OPTIONS` autenticado por credencial HMAC dedicada em 3 edges-piloto, a edge-relé `sonda-relay`, a allowlist positiva, o runner que EXECUTA cada closure histórico com o `OPTIONS` do relé e conta efeito, o gate `sonda:cron-prova` e o teste sempre-on de rollback — sem banco (F2) e sem CLI (F3).

**Architecture:** `_shared/sonda-cron.ts` concentra a credencial (HMAC-SHA256 com `SONDA_HMAC_KEY`, mensagem `sonda-de-versao:v1:<edge>`), o construtor do request de sonda (`OPTIONS`, `redirect: "manual"`, um header) e o classificador do contrato de resposta; a edge-relé só usa esse helper e tem UM `fetch`; cada edge-piloto ganha 2 linhas dentro do bloco `OPTIONS` existente. A prova vive fora de `supabase/functions/` (`supabase/harness-sonda-rollback/`: runner Deno com relógio virtual + stubs por família) e é orquestrada por `scripts/sonda-cron-prova.ts` (Bun): enumera closures históricos por ponto fixo, materializa por `git archive`, gera import map, executa o runner, cacheia em `_shared/sonda-cron-prova.json` com chave (closure, harness).

**Tech Stack:** Deno 2.9.2 (edges, runner, testes `deno test --no-remote`), Bun + TypeScript strict (scripts, `tsconfig.scripts.json`), vitest (gates de texto), git (`archive`, `log --follow`), Web Crypto (HMAC).

## Global Constraints

- Responda/commite/documente em **português brasileiro**; código e rotas em pt-BR.
- `bun run test:edges` roda com `--no-remote` — **nunca afrouxe o flag**; edge nova não pode importar `npm:`/`https:` se quiser teste Deno (o relé não importa nada remoto).
- Edge instrumentada tem 5 gates: `test:edges`, `edges:typecheck`, vitest, `sonda:bump` (`VERSAO` bumpa quando a pasta muda), `sonda:fingerprint -- --write` (regenera `_shared/sonda-fingerprints.ts`; edge nova = entrada nova).
- Edge NOVA precisa de `versao.ts` com `export const VERSAO` **e** entrada no mapa de fingerprints (gate `sonda:nova`), e de entrada em `EDGES` de `supabase/functions/_shared/sonda-versao-contrato_test.ts`.
- Formato de `VERSAO`: `vN.N-slug` (regex do gate de contrato). Bumps desta fatia: `monthly-report` `v1.0-sensor-inicial` → `v1.1-sonda-options`; `calculate-scores` `v1.0-sensor-inicial` → `v1.1-sonda-options`; `sync-reprocess` `v1.2-reconcile-cas-e-ambiguidade` → `v1.3-sonda-options`; `sonda-relay` nasce em `v1.0-rele-options`.
- O bloco `OPTIONS` das edges devolve **a mesma `Response` de hoje** quando o header `x-sonda-credencial` está ausente ou inválido (`new Response(null, { headers: corsHeaders })` — não mude o objeto).
- Constantes canônicas (mesmas strings na spec, no relé, no runner e — em F2 — na migration): `HEADER_SONDA = "x-sonda-credencial"`, `METODO_SONDA = "OPTIONS"`, `MENSAGEM_SONDA_PREFIXO = "sonda-de-versao:v1:"`, env `SONDA_HMAC_KEY`.
- Vetores fixos: HMAC(`Jefe`, `what do ya want for nothing?`) = `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843`; HMAC(`Jefe`, `sonda-de-versao:v1:monthly-report`) = `04855b66e0237a22cb2039fa2859d597b90adf29ee61ce9cd2f3d03c37e7ce42`; `…:calculate-scores` = `325f17a6509571aa519f49ec2422bbde00d2ec225b496549906f74ae6b5079cb`; `…:sync-reprocess` = `48f9b5235b76111f7e08312b3abb00e942d7a827793565039cda7976e7174702`; `…:sonda-relay` = `c09cdd0051980ceff1989c755d98a9ef47a592ecd193627041c83836a364943d`.
- Diretório da prova **fora** de `supabase/functions/`, `scripts/` e `db/`: `supabase/harness-sonda-rollback/`. Testes Deno lá terminam em `_test.ts` e rodam por script próprio.
- Arquivos novos em `scripts/` são type-checados por `tsc -p tsconfig.scripts.json` (Node/Bun APIs, sem `Deno.*`).
- Nada de `git stash` cru; commits pequenos e frequentes; ao final, PR **draft** até a evidência de falsificação estar no corpo (o auto-merge fecha PR não-draft ao CI passar).
- Evidência POSITIVA em toda validação: rode o comando, capture `exit 0` colado. Falsifique (sabote e exija vermelho que NOMEIE o assert) antes de declarar um gate pronto — e **commite antes de falsificar** (`git checkout --` restaura).

## Estrutura de arquivos

| arquivo | responsabilidade |
|---|---|
| `supabase/functions/_shared/sonda-cron.ts` (novo) | constantes; `derivarCredencial`, `verificarCredencial`; `atenderSondaOptions`; `montarRequestSonda`; `classificarRespostaAlvo`; `barreiraSaida` |
| `supabase/functions/_shared/sonda-cron_test.ts` (novo) | testes puros do helper (vetores, negativos, contrato, barreira) |
| `supabase/functions/_shared/sonda-cron-alvos.ts` (novo) | `SONDA_CRON_ALVOS` (allowlist positiva: 3 pilotos + relé) e o tipo `AlvoSondaCron` |
| `supabase/functions/sonda-relay/index.ts`, `versao.ts` (novos) | a edge-relé: gate `authorizeCron`, allowlist, um `fetch` `OPTIONS`, barreira runtime, classificação |
| `supabase/functions/sonda-relay/index_test.ts` (novo) | handler capturado com `Deno.serve` stubado; `fetch` stubado inspeciona o `Request` real; redirects |
| `supabase/config.toml` | `[functions.sonda-relay] verify_jwt = false` |
| `supabase/functions/{monthly-report,calculate-scores,sync-reprocess}/index.ts` + `versao.ts` | ramo no bloco `OPTIONS` + bump |
| `supabase/functions/_shared/sonda-versao-contrato_test.ts` | `sonda-relay` em `EDGES`; gate `SONDA_OPTIONS`: posição do ramo dentro do bloco `OPTIONS` |
| `supabase/functions/_shared/sonda-fingerprints.ts` | regenerado (`sonda:fingerprint -- --write`) |
| `supabase/harness-sonda-rollback/stubs/*.ts` (novos) | contador + Proxy; `supabase-js`, `std-serve`, `resend`, `anthropic`, `web-push` |
| `supabase/harness-sonda-rollback/runner.ts` (novo) | executa UM closure: patches (`Deno.serve`, `Deno.env.get`, `fetch`, timers, `EdgeRuntime.waitUntil`), `import()`, protocolo (a)(b)(c), veredito JSON |
| `supabase/harness-sonda-rollback/rollback_test.ts` (novo) | teste sempre-on: fixtures materializadas de git (`ef08dddd2`, `81f9a111c`, `0ed5a9b31`, `45a80118b`, `d33c83836`) + bundle atual + relé; asserts 1–9 |
| `supabase/harness-sonda-rollback/sinteticos/*/index.ts` (novos) | closures sintéticos do `OPTIONS` (falsificação) |
| `scripts/sonda-cron-prova.ts` + `.test.ts` (novos) | enumeração (ponto fixo), materialização, import map, cache, G1/G2/G4, `--falsificar` |
| `supabase/functions/_shared/sonda-cron-prova.json` (novo, gerado) | manifesto de vereditos por (closure, harness) |
| `package.json`, `.github/workflows/ci.yml` | scripts `test:sonda-rollback`, `sonda:cron-prova` + 2 steps blocking |
| `docs/historico/sonda-por-cron-fail-closed.md` (novo), `docs/historico/README.md`, `docs/agent/deploy.md` | registro da entrega + índice + ponteiro |

---

### Task 1: `_shared/sonda-cron.ts` — credencial, request de sonda, contrato de resposta, ramo `OPTIONS`

**Files:**
- Create: `supabase/functions/_shared/sonda-cron.ts`
- Test: `supabase/functions/_shared/sonda-cron_test.ts`

**Interfaces:**
- Consumes: `criarRespostaSonda` (tipo de `respostaSonda`) de `./sonda-versao.ts` (já existe).
- Produces (usados por Tasks 3–7):
  - `HEADER_SONDA: "x-sonda-credencial"`, `METODO_SONDA: "OPTIONS"`, `MENSAGEM_SONDA_PREFIXO: "sonda-de-versao:v1:"`, `ENV_CHAVE_SONDA: "SONDA_HMAC_KEY"`, `TAMANHO_MIN_CHAVE_BYTES = 32`
  - `derivarCredencial(chave: string, edge: string): Promise<string>` (hex minúsculo)
  - `verificarCredencial(chave: string | undefined, edge: string, recebida: string | null): Promise<boolean>`
  - `chaveUtilizavel(chave: string | undefined): chave is string`
  - `atenderSondaOptions(req: Request, respostaSonda: (v: string) => CorpoSonda, versao: string, chave?: string | undefined): Promise<Response | null>`
  - `montarRequestSonda(baseUrl: string, alvo: string, credencial: string): Request`
  - `type ClasseResposta = "atestou" | "cors-sem-sonda" | "contrato-invalido" | "identidade-divergente" | "redirect" | "timeout" | "erro-http"`
  - `classificarRespostaAlvo(alvo: string, status: number, contentType: string | null, texto: string): { classe: ClasseResposta; corpo?: string }`
  - `barreiraSaida(req: Request, baseUrl: string, alvo: string, allowlist: ReadonlySet<string>): string | null` (mensagem da violação ou `null`)

- [ ] **Step 1: Escrever os testes que falham**

```ts
// supabase/functions/_shared/sonda-cron_test.ts
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-cron_test.ts
import {
  atenderSondaOptions, barreiraSaida, chaveUtilizavel, classificarRespostaAlvo, derivarCredencial,
  HEADER_SONDA, METODO_SONDA, montarRequestSonda, verificarCredencial,
} from "./sonda-cron.ts";
import { criarRespostaSonda } from "./sonda-versao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}
const CHAVE = "Jefe";
const CHAVE_FORTE = "u".repeat(44); // 44 chars base64 ≈ 33 bytes decodificados
const respostaSonda = criarRespostaSonda("monthly-report");

Deno.test("derivarCredencial: vetores fixos (RFC 4231 #2 e mensagem real por edge)", async () => {
  assertEquals(await derivarCredencial(CHAVE, "__rfc4231__"), await derivarCredencial(CHAVE, "__rfc4231__")); // determinística
  assertEquals(await derivarCredencial(CHAVE, "monthly-report"), "04855b66e0237a22cb2039fa2859d597b90adf29ee61ce9cd2f3d03c37e7ce42");
  assertEquals(await derivarCredencial(CHAVE, "calculate-scores"), "325f17a6509571aa519f49ec2422bbde00d2ec225b496549906f74ae6b5079cb");
  assertEquals(await derivarCredencial(CHAVE, "sonda-relay"), "c09cdd0051980ceff1989c755d98a9ef47a592ecd193627041c83836a364943d");
});

Deno.test("verificarCredencial: aceita a própria edge; recusa outra edge, hex inválido, ausente, chave ausente", async () => {
  const cred = await derivarCredencial(CHAVE, "monthly-report");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", cred), true);
  assertEquals(await verificarCredencial(CHAVE, "calculate-scores", cred), false, "credencial de OUTRA edge");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", "zz" + cred.slice(2)), false, "hex inválido");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", cred.slice(0, 10)), false, "tamanho errado");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", null), false, "ausente");
  assertEquals(await verificarCredencial(undefined, "monthly-report", cred), false, "chave ausente");
  assertEquals(await verificarCredencial("", "monthly-report", cred), false, "chave vazia");
});

Deno.test("chaveUtilizavel: ausente/vazia/curta → false (checagem de FORMA; entropia vem do procedimento)", () => {
  assertEquals(chaveUtilizavel(undefined), false);
  assertEquals(chaveUtilizavel(""), false);
  assertEquals(chaveUtilizavel("curta"), false);
  assertEquals(chaveUtilizavel(CHAVE_FORTE), true);
});

Deno.test("atenderSondaOptions: só responde com credencial válida; nunca lê corpo; na dúvida, null", async () => {
  const cred = await derivarCredencial(CHAVE_FORTE, "monthly-report");
  const url = "http://x/functions/v1/monthly-report";
  const ok = await atenderSondaOptions(new Request(url, { method: "OPTIONS", headers: { [HEADER_SONDA]: cred } }), respostaSonda, "v9.9-teste", CHAVE_FORTE);
  if (!ok) throw new Error("credencial válida tinha de responder");
  assertEquals(ok.status, 200);
  const corpo = await ok.json();
  assertEquals(corpo.probe, true); assertEquals(corpo.edge, "monthly-report"); assertEquals(corpo.versao, "v9.9-teste"); assertEquals(corpo.ok, true);
  assertEquals(typeof corpo.fonte, "string");
  for (const [nome, headers] of Object.entries({
    ausente: {}, invalida: { [HEADER_SONDA]: "zz" }, outraEdge: { [HEADER_SONDA]: await derivarCredencial(CHAVE_FORTE, "calculate-scores") },
  })) {
    assertEquals(await atenderSondaOptions(new Request(url, { method: "OPTIONS", headers }), respostaSonda, "v9.9-teste", CHAVE_FORTE), null, nome);
  }
  assertEquals(await atenderSondaOptions(new Request(url, { method: "OPTIONS", headers: { [HEADER_SONDA]: cred } }), respostaSonda, "v9.9-teste", undefined), null, "sem chave");
  assertEquals(await atenderSondaOptions(new Request(url, { method: "POST", headers: { [HEADER_SONDA]: cred }, body: "{}" }), respostaSonda, "v9.9-teste", CHAVE_FORTE), null, "método ≠ OPTIONS");
});

Deno.test("montarRequestSonda: OPTIONS, um header, corpo nulo, redirect manual, URL do projeto", () => {
  const r = montarRequestSonda("https://ref.supabase.co", "monthly-report", "abc");
  assertEquals(r.method, METODO_SONDA);
  assertEquals([...r.headers.keys()], [HEADER_SONDA]);
  assertEquals(r.headers.get(HEADER_SONDA), "abc");
  assertEquals(r.body, null);
  assertEquals(r.redirect, "manual");
  assertEquals(r.url, "https://ref.supabase.co/functions/v1/monthly-report");
});

Deno.test("classificarRespostaAlvo: contrato completo atesta; qualquer coisa mais fraca não", () => {
  const bom = JSON.stringify({ ok: true, probe: true, versao: "v1.1-x", edge: "monthly-report", fonte: "a".repeat(64) });
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", bom), { classe: "atestou", corpo: bom });
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "text/plain;charset=UTF-8", "ok").classe, "cors-sem-sonda");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, null, "").classe, "cors-sem-sonda");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", JSON.stringify({ probe: true, edge: "monthly-report", versao: "x" })).classe, "contrato-invalido", "sem ok/fonte");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", JSON.stringify({ ok: true, probe: "true", edge: "monthly-report", versao: "x", fonte: "nao-mapeada" })).classe, "contrato-invalido", "probe string");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", JSON.stringify({ ok: true, probe: true, edge: "outra", versao: "x", fonte: "nao-mapeada" })).classe, "identidade-divergente");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", "[1]").classe, "contrato-invalido", "array");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", "{".padEnd(5000, " ")).classe, "contrato-invalido", "> 4 KB");
  for (const s of [301, 302, 303, 307, 308]) assertEquals(classificarRespostaAlvo("monthly-report", s, null, "").classe, "redirect", `status ${s}`);
  assertEquals(classificarRespostaAlvo("monthly-report", 500, null, "").classe, "erro-http");
});

Deno.test("barreiraSaida: só OPTIONS, só o header, corpo nulo, redirect manual, origem e path do alvo allowlisted", () => {
  const base = "https://ref.supabase.co"; const allow = new Set(["monthly-report"]);
  const bom = montarRequestSonda(base, "monthly-report", "abc");
  assertEquals(barreiraSaida(bom, base, "monthly-report", allow), null);
  assertEquals(barreiraSaida(new Request(bom.url, { method: "POST", headers: { [HEADER_SONDA]: "abc" }, redirect: "manual" }), base, "monthly-report", allow)?.includes("OPTIONS"), true);
  assertEquals(barreiraSaida(new Request(bom.url, { method: "OPTIONS", headers: { [HEADER_SONDA]: "abc", "x-cron-secret": "s" }, redirect: "manual" }), base, "monthly-report", allow)?.includes("header"), true);
  assertEquals(barreiraSaida(new Request(bom.url, { method: "OPTIONS", headers: { [HEADER_SONDA]: "abc" } }), base, "monthly-report", allow)?.includes("redirect"), true);
  assertEquals(barreiraSaida(montarRequestSonda("https://outro.host", "monthly-report", "abc"), base, "monthly-report", allow)?.includes("origem"), true);
  assertEquals(barreiraSaida(montarRequestSonda(base, "calculate-scores", "abc"), base, "calculate-scores", allow)?.includes("allowlist"), true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-cron_test.ts`
Expected: FAIL — `Module not found "file://…/_shared/sonda-cron.ts"`.

- [ ] **Step 3: Implementar o helper**

```ts
// supabase/functions/_shared/sonda-cron.ts
// Sonda de deploy por cron, fail-closed no bundle velho — o lado das EDGES.
// Spec: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md (v5, aprovada
// pelo challenge Codex em 3 rodadas). Por que OPTIONS: é a única requisição que TODO bundle
// histórico (inclusive os SEM gate, ex.: monthly-report@ef08dddd2) interrompe antes de qualquer
// IO. Por que credencial dedicada (SONDA_HMAC_KEY, só nas edges): não é o CRON_SECRET, não
// autoriza nada além de responder {versao, edge, fonte}, e um vazamento não vira verificador
// offline de outro segredo.
import type { criarRespostaSonda } from "./sonda-versao.ts";

export const HEADER_SONDA = "x-sonda-credencial" as const;
export const METODO_SONDA = "OPTIONS" as const;
export const MENSAGEM_SONDA_PREFIXO = "sonda-de-versao:v1:" as const;
export const ENV_CHAVE_SONDA = "SONDA_HMAC_KEY" as const;
/** Forma mínima da chave (32 bytes decodificados de base64 ≈ 43 chars). Entropia vem do procedimento. */
export const TAMANHO_MIN_CHAVE_BYTES = 32;
export const TAMANHO_MAX_CORPO_ATESTACAO = 4096;

export type CorpoSonda = ReturnType<ReturnType<typeof criarRespostaSonda>>;
export type ClasseResposta =
  | "atestou" | "cors-sem-sonda" | "contrato-invalido" | "identidade-divergente" | "redirect" | "timeout" | "erro-http";

const enc = new TextEncoder();

function bytesDaChave(chave: string): number {
  // base64 → bytes; se não for base64, conta os bytes UTF-8 (chave gerada por openssl é base64).
  try { return atob(chave).length; } catch { return enc.encode(chave).length; }
}

export function chaveUtilizavel(chave: string | undefined): chave is string {
  return typeof chave === "string" && chave.length > 0 && bytesDaChave(chave) >= TAMANHO_MIN_CHAVE_BYTES;
}

async function chaveHmac(chave: string, usos: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(chave), { name: "HMAC", hash: "SHA-256" }, false, usos);
}

export async function derivarCredencial(chave: string, edge: string): Promise<string> {
  const k = await chaveHmac(chave, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(MENSAGEM_SONDA_PREFIXO + edge));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexParaBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verificação em tempo constante (crypto.subtle.verify). Qualquer dúvida → false. */
export async function verificarCredencial(chave: string | undefined, edge: string, recebida: string | null): Promise<boolean> {
  if (!chave || !recebida) return false;
  const bytes = hexParaBytes(recebida.toLowerCase());
  if (!bytes) return false;
  try {
    const k = await chaveHmac(chave, ["verify"]);
    return await crypto.subtle.verify("HMAC", k, bytes, enc.encode(MENSAGEM_SONDA_PREFIXO + edge));
  } catch { return false; }
}

/**
 * O ramo da EDGE-ALVO, chamado DENTRO do bloco `OPTIONS` existente. Devolve a resposta da sonda
 * só com credencial válida para ESTA edge; em qualquer outra situação devolve `null`, e a edge
 * segue devolvendo a Response de CORS de sempre (na dúvida, preflight). Não lê o corpo, não faz IO.
 */
export async function atenderSondaOptions(
  req: Request,
  respostaSonda: (versao: string) => CorpoSonda,
  versao: string,
  chave: string | undefined = Deno.env.get(ENV_CHAVE_SONDA),
): Promise<Response | null> {
  try {
    if (req.method !== METODO_SONDA) return null;
    const recebida = req.headers.get(HEADER_SONDA);
    if (recebida === null || !chaveUtilizavel(chave)) return null;
    const corpo = respostaSonda(versao);
    if (!(await verificarCredencial(chave, corpo.edge, recebida))) return null;
    return new Response(JSON.stringify(corpo), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch { return null; }
}

/** O request que o RELÉ envia à alvo. Sem parâmetro de método: OPTIONS é a única forma possível. */
export function montarRequestSonda(baseUrl: string, alvo: string, credencial: string): Request {
  const url = new URL(`/functions/v1/${alvo}`, baseUrl);
  return new Request(url.toString(), {
    method: METODO_SONDA,
    headers: { [HEADER_SONDA]: credencial },
    body: null,
    redirect: "manual",
  });
}

/** Segunda barreira, avaliada em runtime imediatamente antes do único fetch do relé. */
export function barreiraSaida(req: Request, baseUrl: string, alvo: string, allowlist: ReadonlySet<string>): string | null {
  if (!allowlist.has(alvo)) return `alvo fora da allowlist: ${alvo}`;
  if (req.method !== METODO_SONDA) return `método ${req.method} — só OPTIONS sai do relé`;
  const chaves = [...req.headers.keys()];
  if (chaves.length !== 1 || chaves[0] !== HEADER_SONDA) return `header inesperado no request de saída: ${chaves.join(",")}`;
  if (req.body !== null) return "corpo não nulo no request de saída";
  if (req.redirect !== "manual") return `redirect ${req.redirect} — tem de ser manual`;
  const u = new URL(req.url);
  if (u.origin !== new URL(baseUrl).origin) return `origem ${u.origin} ≠ ${new URL(baseUrl).origin}`;
  if (u.pathname !== `/functions/v1/${alvo}`) return `pathname ${u.pathname} ≠ /functions/v1/${alvo}`;
  return null;
}

/** O contrato COMPLETO da atestação (o que a janela viva aceita), antes de repassar verbatim. */
export function classificarRespostaAlvo(
  alvo: string, status: number, contentType: string | null, texto: string,
): { classe: ClasseResposta; corpo?: string } {
  if (status >= 300 && status < 400) return { classe: "redirect" };
  if (status !== 200) return { classe: "erro-http" };
  const ehJson = (contentType ?? "").toLowerCase().includes("json");
  if (!ehJson || texto.trim() === "") return { classe: "cors-sem-sonda" };
  if (texto.length > TAMANHO_MAX_CORPO_ATESTACAO) return { classe: "contrato-invalido" };
  let j: unknown;
  try { j = JSON.parse(texto); } catch { return { classe: "contrato-invalido" }; }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return { classe: "contrato-invalido" };
  const o = j as Record<string, unknown>;
  const fonteOk = typeof o.fonte === "string" && (/^[0-9a-f]{64}$/.test(o.fonte) || o.fonte === "nao-mapeada");
  const versaoOk = typeof o.versao === "string" && o.versao.length >= 1 && o.versao.length <= 120;
  if (o.ok !== true || o.probe !== true || !versaoOk || !fonteOk || typeof o.edge !== "string") return { classe: "contrato-invalido" };
  if (o.edge !== alvo) return { classe: "identidade-divergente" };
  return { classe: "atestou", corpo: texto };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-cron_test.ts`
Expected: `ok | 7 passed | 0 failed`. Depois: `bun run test:edges` — tudo verde (o arquivo novo entra na varredura).

- [ ] **Step 5: Falsificar UMA camada (e restaurar)**

Troque, em `verificarCredencial`, `MENSAGEM_SONDA_PREFIXO + edge` por `MENSAGEM_SONDA_PREFIXO` (sem a edge). Run: o teste `verificarCredencial: … recusa outra edge …` tem de FALHAR nomeando "credencial de OUTRA edge". Restaure com `git checkout -- supabase/functions/_shared/sonda-cron.ts` **depois de commitar** o Step 6 — ou faça a sabotagem após o commit.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/sonda-cron.ts supabase/functions/_shared/sonda-cron_test.ts
git commit -m "feat(sonda-cron): helper da sonda por OPTIONS — credencial HMAC dedicada por edge, request de saída sem parâmetro de método, contrato completo da atestação, barreira de saída"
```

### Task 2: `_shared/sonda-cron-alvos.ts` — a allowlist positiva (default-deny)

**Files:**
- Create: `supabase/functions/_shared/sonda-cron-alvos.ts`
- Test: `supabase/functions/_shared/sonda-cron-alvos_test.ts`

**Interfaces:**
- Produces: `type ControlePositivo = { metodo: "POST"; headers: Record<string, string>; corpo: string | null; nota: string }`; `type AlvoSondaCron = { edge: string; desde: string | null; controles: readonly ControlePositivo[] }`; `SONDA_CRON_ALVOS: readonly AlvoSondaCron[]`; `slugsDaAllowlist(): ReadonlySet<string>`. Valores `$NOME` em `headers` são resolvidos pelo runner contra a env de teste (Task 5). `desde: null` = "o ramo ainda não está na história" (toda closure tem de responder CORS); a Task 4 grava o sha.

- [ ] **Step 1: Teste que falha**

```ts
// supabase/functions/_shared/sonda-cron-alvos_test.ts
import { SONDA_CRON_ALVOS, slugsDaAllowlist } from "./sonda-cron-alvos.ts";
function assert(c: unknown, msg: string) { if (!c) throw new Error(msg); }
Deno.test("allowlist: slugs válidos, únicos, com ≥1 controle positivo cada e o relé presente", () => {
  const vistos = new Set<string>();
  for (const a of SONDA_CRON_ALVOS) {
    assert(/^[a-z0-9-]{1,80}$/.test(a.edge), `slug fora do formato: ${a.edge}`);
    assert(!vistos.has(a.edge), `slug repetido: ${a.edge}`); vistos.add(a.edge);
    assert(a.controles.length >= 1, `${a.edge}: sem controle positivo`);
    for (const c of a.controles) assert(c.metodo === "POST" && c.nota.length >= 20, `${a.edge}: controle sem método/nota`);
    assert(a.desde === null || /^[0-9a-f]{7,40}$/.test(a.desde), `${a.edge}: desde inválido`);
  }
  assert(slugsDaAllowlist().has("sonda-relay"), "o relé precisa estar na própria allowlist");
  assert(slugsDaAllowlist().size === SONDA_CRON_ALVOS.length, "slugsDaAllowlist ≠ lista");
});
```

- [ ] **Step 2: Rodar e ver falhar** — `deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-cron-alvos_test.ts` → `Module not found`.

- [ ] **Step 3: Implementar**

```ts
// supabase/functions/_shared/sonda-cron-alvos.ts
// ALLOWLIST POSITIVA da sonda por cron (default-deny). Uma edge só entra aqui depois de
// `bun run sonda:cron-prova` executar 100 % dos closures históricos dela com o OPTIONS do relé
// e contar zero efeito (spec v5 §4.4). O banco (F2) espelha esta lista; o relé a importa.
export type ControlePositivo = {
  metodo: "POST";
  /** `$NOME` é resolvido pelo runner contra a env de teste (CRON_SECRET, SUPABASE_SERVICE_ROLE_KEY, …). */
  headers: Record<string, string>;
  corpo: string | null;
  /** Por que este controle dispara o fluxo real nesta edge/época — o leitor do manifesto precisa saber. */
  nota: string;
};
export type AlvoSondaCron = {
  edge: string;
  /** sha que introduziu o ramo `atenderSondaOptions`; null = ramo ainda fora da história. */
  desde: string | null;
  controles: readonly ControlePositivo[];
};
const JSON_ = { "content-type": "application/json" };
const CRON: ControlePositivo = { metodo: "POST", headers: { ...JSON_, "x-cron-secret": "$CRON_SECRET" }, corpo: "{}", nota: "época authorizeCron/authorizeCronOrStaff: x-cron-secret libera o fluxo real" };
const BEARER: ControlePositivo = { metodo: "POST", headers: { ...JSON_, Authorization: "Bearer $SUPABASE_SERVICE_ROLE_KEY" }, corpo: "{}", nota: "época só-JWT/service role (calculate-scores até 2026-06): só o Bearer libera" };
export const SONDA_CRON_ALVOS: readonly AlvoSondaCron[] = [
  { edge: "sonda-relay", desde: null, controles: [{ metodo: "POST", headers: { ...JSON_, "x-cron-secret": "$CRON_SECRET" }, corpo: '{"alvo":"monthly-report","tick":"t"}', nota: "o POST operacional do cron: o efeito visível é o fetch OPTIONS de saída" }] },
  { edge: "monthly-report", desde: null, controles: [CRON, BEARER] },
  { edge: "calculate-scores", desde: null, controles: [CRON, BEARER] },
  { edge: "sync-reprocess", desde: null, controles: [{ ...CRON, corpo: '{"action":"reprocess_orders","empresa":"oben"}', nota: "roteia por action: corpo vazio cai em 400 sem IO; reprocess_orders lê o banco" }, BEARER] },
];
export function slugsDaAllowlist(): ReadonlySet<string> {
  return new Set(SONDA_CRON_ALVOS.map((a) => a.edge));
}
```

- [ ] **Step 4: Rodar e ver passar** — o mesmo comando → `1 passed`. Confira o `action` real de `sync-reprocess`: `grep -n "case '" supabase/functions/sync-reprocess/index.ts | head` — use um `action` existente no HEAD (o runner testa escada; se `reprocess_orders` não existir, troque pelo primeiro `case` que lê o banco).

- [ ] **Step 5: Commit** — `git add supabase/functions/_shared/sonda-cron-alvos.ts supabase/functions/_shared/sonda-cron-alvos_test.ts && git commit -m "feat(sonda-cron): allowlist positiva da sonda por cron (relé + 3 pilotos), controles por época de auth"`

### Task 3: a edge-relé `sonda-relay`

**Files:**
- Create: `supabase/functions/sonda-relay/versao.ts`, `supabase/functions/sonda-relay/index.ts`, `supabase/functions/sonda-relay/index_test.ts`
- Modify: `supabase/config.toml` (nova seção), `supabase/functions/_shared/sonda-versao-contrato_test.ts` (import + entrada em `EDGES`), `supabase/functions/_shared/sonda-fingerprints.ts` (regenerado)

**Interfaces:**
- Consumes: Task 1 (`atenderSondaOptions`, `montarRequestSonda`, `barreiraSaida`, `classificarRespostaAlvo`, `derivarCredencial`, `chaveUtilizavel`, `ENV_CHAVE_SONDA`), Task 2 (`slugsDaAllowlist`), `authorizeCron` de `../_shared/auth.ts`, `criarRespostaSonda`/`classificarSonda`/`erroSondaAmbigua` de `../_shared/sonda-versao.ts`.
- Produces: contrato HTTP do relé — `POST {alvo, tick}` + `x-cron-secret` → 200 com corpo verbatim da alvo (atestação) **ou** `{ok:false, alvo, tick, classe, status?}`; 400 `fora-da-allowlist`; 401 sem cron secret; 500 `sem-chave`/`sem-base-url`/`barreira`. `OPTIONS` + credencial → sonda do próprio relé.

- [ ] **Step 1: `versao.ts`**

```ts
// supabase/functions/sonda-relay/versao.ts
export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";
/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("sonda-relay");
/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-rele-options";
/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge faz UMA requisição OPTIONS na edge-alvo da allowlist com a credencial de sonda e devolve " +
  "o corpo da atestação; não escreve em banco nem chama ERP — o custo de um disparo indevido é uma " +
  "linha a mais em net._http_response";
```

- [ ] **Step 2: Teste do handler que falha (fetch stubado inspeciona o `Request` real)**

```ts
// supabase/functions/sonda-relay/index_test.ts
// Roda em: deno test --no-remote --allow-read=supabase/functions supabase/functions/sonda-relay/
import { derivarCredencial, HEADER_SONDA } from "../_shared/sonda-cron.ts";
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}\n  esperado ${JSON.stringify(b)}\n  recebido ${JSON.stringify(a)}`); }
const ENV: Record<string, string> = { CRON_SECRET: "cron-de-teste", SONDA_HMAC_KEY: "u".repeat(44), SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srk" };
let handler: ((r: Request) => Promise<Response>) | null = null;
(Deno as unknown as { serve: unknown }).serve = (a: unknown, b?: unknown) => { handler = (typeof a === "function" ? a : b) as typeof handler; return {}; };
(Deno.env as unknown as { get: (k: string) => string | undefined }).get = (k) => ENV[k];
const chamadas: Request[] = [];
let responder: (r: Request) => Promise<Response> = async () => new Response(null);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = new Request(input, init); chamadas.push(r); return await responder(r);
}) as typeof fetch;
await import("./index.ts");
const h = handler!;
const URL_RELE = "https://ref.supabase.co/functions/v1/sonda-relay";
const cron = (corpo: unknown) => new Request(URL_RELE, { method: "POST", headers: { "content-type": "application/json", "x-cron-secret": "cron-de-teste" }, body: JSON.stringify(corpo) });
const ATESTACAO = JSON.stringify({ ok: true, probe: true, versao: "v1.1-x", edge: "monthly-report", fonte: "a".repeat(64) });
const json = (s: string, status = 200, extra: Record<string, string> = {}) => new Response(s, { status, headers: { "content-type": "application/json", ...extra } });

Deno.test("relé: sem x-cron-secret → 401 e zero fetch", async () => {
  chamadas.length = 0;
  const r = await h(new Request(URL_RELE, { method: "POST", body: "{}" }));
  eq(r.status, 401, "status"); eq(chamadas.length, 0, "fetch");
});
Deno.test("relé: alvo fora da allowlist → 400 fora-da-allowlist e zero fetch", async () => {
  chamadas.length = 0;
  const r = await h(cron({ alvo: "omie-webhook", tick: "t" }));
  eq(r.status, 400, "status"); eq((await r.json()).classe, "fora-da-allowlist", "classe"); eq(chamadas.length, 0, "fetch");
});
Deno.test("relé: alvo válido → exatamente 1 fetch OPTIONS, um header, corpo nulo, redirect manual, URL do projeto", async () => {
  chamadas.length = 0; responder = async () => json(ATESTACAO);
  const r = await h(cron({ alvo: "monthly-report", tick: "t" }));
  eq(r.status, 200, "status"); eq(await r.text(), ATESTACAO, "corpo verbatim");
  eq(chamadas.length, 1, "um fetch"); const s = chamadas[0];
  eq(s.method, "OPTIONS", "método"); eq([...s.headers.keys()], [HEADER_SONDA], "headers"); eq(s.body, null, "corpo"); eq(s.redirect, "manual", "redirect");
  eq(s.url, "https://ref.supabase.co/functions/v1/monthly-report", "url");
  eq(s.headers.get(HEADER_SONDA), await derivarCredencial(ENV.SONDA_HMAC_KEY, "monthly-report"), "credencial por edge");
});
Deno.test("relé: classes — cors-sem-sonda, identidade-divergente, contrato-invalido, redirect sem 2º fetch, timeout, erro-http", async () => {
  const casos: Array<[string, (r: Request) => Promise<Response>, string]> = [
    ["cors", async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }), "cors-sem-sonda"],
    ["identidade", async () => json(ATESTACAO.replace("monthly-report", "outra")), "identidade-divergente"],
    ["contrato", async () => json(JSON.stringify({ probe: true, edge: "monthly-report", versao: "x" })), "contrato-invalido"],
    ["303", async () => new Response(null, { status: 303, headers: { Location: "/functions/v1/monthly-report" } }), "redirect"],
    ["timeout", async () => { throw new DOMException("t", "TimeoutError"); }, "timeout"],
    ["500", async () => new Response("x", { status: 500 }), "erro-http"],
  ];
  for (const [nome, resp, classe] of casos) {
    chamadas.length = 0; responder = resp;
    const r = await h(cron({ alvo: "monthly-report", tick: "t" }));
    const j = await r.json();
    eq(r.status, 200, `${nome}: status`); eq(j.ok, false, `${nome}: ok`); eq(j.classe, classe, `${nome}: classe`);
    eq("edge" in j || "versao" in j, false, `${nome}: corpo de erro não pode ter edge/versao no topo`);
    eq(chamadas.length, 1, `${nome}: exatamente 1 fetch (redirect não é seguido)`);
  }
});
Deno.test("relé: SONDA_HMAC_KEY ausente → 500 sem-chave e zero fetch", async () => {
  const guardada = ENV.SONDA_HMAC_KEY; delete ENV.SONDA_HMAC_KEY; chamadas.length = 0;
  const r = await h(cron({ alvo: "monthly-report", tick: "t" }));
  eq(r.status, 500, "status"); eq((await r.json()).classe, "sem-chave", "classe"); eq(chamadas.length, 0, "fetch");
  ENV.SONDA_HMAC_KEY = guardada;
});
Deno.test("relé: OPTIONS com credencial responde a própria sonda; sem credencial devolve CORS", async () => {
  const cred = await derivarCredencial(ENV.SONDA_HMAC_KEY, "sonda-relay");
  const r = await h(new Request(URL_RELE, { method: "OPTIONS", headers: { [HEADER_SONDA]: cred } }));
  const j = await r.json(); eq(j.probe, true, "probe"); eq(j.edge, "sonda-relay", "edge");
  const c = await h(new Request(URL_RELE, { method: "OPTIONS" })); eq(c.status, 200, "cors"); eq(await c.text(), "", "corpo vazio");
});
Deno.test("relé: POST {probe:true} com cron secret responde a sonda (caminho humano legado)", async () => {
  chamadas.length = 0;
  const r = await h(cron({ probe: true })); const j = await r.json();
  eq(j.probe, true, "probe"); eq(j.edge, "sonda-relay", "edge"); eq(chamadas.length, 0, "fetch");
});
```

- [ ] **Step 3: Rodar e ver falhar** — `deno test --no-remote --allow-read=supabase/functions supabase/functions/sonda-relay/` → `Module not found "./index.ts"`.

- [ ] **Step 4: Implementar `index.ts`**

```ts
// supabase/functions/sonda-relay/index.ts
// Edge-relé da sonda de deploy por cron (spec v5 §4.3). O cron (pg_net) não emite OPTIONS; este
// relé recebe `POST {alvo, tick}` com x-cron-secret e faz UM `OPTIONS` na alvo com a credencial
// de sonda. É o único componente cujo bug seria catastrófico (mandar POST): por isso o request de
// saída nasce em `montarRequestSonda` (sem parâmetro de método), passa pela `barreiraSaida` em
// runtime e este arquivo tem exatamente UM `fetch(` (gate de texto em scripts/sonda-cron-prova.ts).
import { authorizeCron } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import {
  atenderSondaOptions, barreiraSaida, chaveUtilizavel, classificarRespostaAlvo, derivarCredencial,
  ENV_CHAVE_SONDA, montarRequestSonda,
} from "../_shared/sonda-cron.ts";
import { slugsDaAllowlist } from "../_shared/sonda-cron-alvos.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const ALLOWLIST = slugsDaAllowlist();
const TIMEOUT_MS = 8_000;

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response(null, { headers: corsHeaders });
  }
  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  const corpoBruto = await req.json().catch(() => ({}));
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") return json({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);

  const { alvo, tick } = corpoBruto as { alvo?: unknown; tick?: unknown };
  if (typeof alvo !== "string" || !ALLOWLIST.has(alvo)) {
    return json({ ok: false, alvo: String(alvo), tick, classe: "fora-da-allowlist" }, 400);
  }
  const chave = Deno.env.get(ENV_CHAVE_SONDA);
  if (!chaveUtilizavel(chave)) return json({ ok: false, alvo, tick, classe: "sem-chave" }, 500);
  const baseUrl = Deno.env.get("SUPABASE_URL");
  if (!baseUrl) return json({ ok: false, alvo, tick, classe: "sem-base-url" }, 500);

  const saida = montarRequestSonda(baseUrl, alvo, await derivarCredencial(chave, alvo));
  const violacao = barreiraSaida(saida, baseUrl, alvo, ALLOWLIST);
  if (violacao) return json({ ok: false, alvo, tick, classe: "barreira", motivo: violacao }, 500);

  let resposta: Response;
  try {
    resposta = await fetch(saida, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof DOMException && e.name === "TimeoutError";
    return json({ ok: false, alvo, tick, classe: timeout ? "timeout" : "erro-http" }, 200);
  }
  const texto = await resposta.text().catch(() => "");
  const r = classificarRespostaAlvo(alvo, resposta.status, resposta.headers.get("content-type"), texto);
  if (r.classe === "atestou") {
    return new Response(r.corpo, { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  return json({ ok: false, alvo, tick, classe: r.classe, status: resposta.status }, 200);
});
```

- [ ] **Step 5: Rodar e ver passar** — `deno test --no-remote --allow-read=supabase/functions supabase/functions/sonda-relay/` → `7 passed`. Se `fetch(saida, { signal })` perder `redirect`/headers no seu runtime, troque por `fetch(new Request(saida, { signal: … }))` e re-rode (o teste do `Request` real é o juiz).

- [ ] **Step 6: `config.toml`, `EDGES`, fingerprint**

Acrescente ao fim de `supabase/config.toml`:
```toml

[functions.sonda-relay]
verify_jwt = false
```
Em `supabase/functions/_shared/sonda-versao-contrato_test.ts`: `import * as sondaRelay from "../sonda-relay/versao.ts";` junto aos outros imports e `{ nome: "sonda-relay", mod: sondaRelay },` como última entrada de `EDGES`. Rode `bun run sonda:fingerprint -- --write` (gera a entrada `sonda-relay` no mapa) e `bun run sonda:nova` (edge nova instrumentada → verde).

- [ ] **Step 7: Todos os gates de edge** — `bun run test:edges && bun run edges:typecheck && bun run sonda:fingerprint && bun run sonda:nova`; capture `exit 0` de cada.

- [ ] **Step 8: Commit** — `git add supabase/functions/sonda-relay supabase/config.toml supabase/functions/_shared/sonda-versao-contrato_test.ts supabase/functions/_shared/sonda-fingerprints.ts && git commit -m "feat(sonda-relay): edge-relé da sonda por cron — um fetch OPTIONS com credencial dedicada, redirect manual, barreira runtime, contrato completo da atestação"`

### Task 4: o ramo `OPTIONS` nas 3 edges-piloto + bump + `desde` + gate de contrato

**Files:**
- Modify: `supabase/functions/monthly-report/index.ts:3,230-232`, `supabase/functions/calculate-scores/index.ts:3,311-313`, `supabase/functions/sync-reprocess/index.ts:20,736-738` (as linhas são as do HEAD de 2026-09-05; ache pelo texto `if (req.method === 'OPTIONS') {`)
- Modify: `supabase/functions/{monthly-report,calculate-scores,sync-reprocess}/versao.ts` (`VERSAO`)
- Modify: `supabase/functions/_shared/sonda-versao-contrato_test.ts` (gate novo), `supabase/functions/_shared/sonda-cron-alvos.ts` (`desde`), `supabase/functions/_shared/sonda-fingerprints.ts` (regenerado)

**Interfaces:**
- Consumes: `atenderSondaOptions` (Task 1), `SONDA_CRON_ALVOS` (Task 2).
- Produces: nas 3 edges, o bloco `OPTIONS` passa a ser exatamente:

```ts
  if (req.method === 'OPTIONS') {
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response(null, { headers: corsHeaders });
  }
```

- [ ] **Step 1: Gate de contrato que falha (posição do ramo dentro do bloco `OPTIONS`)**

Acrescente ao fim de `supabase/functions/_shared/sonda-versao-contrato_test.ts` (o arquivo já tem `codigoDaEdge`/`trechoDoHandler`):

```ts
import { SONDA_CRON_ALVOS } from "./sonda-cron-alvos.ts";

Deno.test("sonda por cron: o ramo atenderSondaOptions vive DENTRO do bloco OPTIONS, antes do CORS, e o CORS não mudou", () => {
  // Spec v5 §4.2: o único lugar em que a alvo responde a sonda por cron é o bloco OPTIONS — o
  // que TODO bundle histórico interrompe antes de IO. Fora do bloco, o ramo deixaria de ser
  // estrutural; depois do `return` de CORS, seria código morto (e o cron ficaria em silêncio).
  for (const { edge } of SONDA_CRON_ALVOS) {
    const h = trechoDoHandler(edge);
    const bloco = h.match(/if \(req\.method === ['"]OPTIONS['"]\) \{([\s\S]*?)\n\s*\}/);
    if (!bloco) throw new Error(`${edge}: bloco OPTIONS não encontrado no handler`);
    const corpo = bloco[1];
    const posRamo = corpo.indexOf("atenderSondaOptions(");
    const posCors = corpo.indexOf("return new Response(null, { headers: corsHeaders })");
    if (posRamo < 0) throw new Error(`${edge}: o bloco OPTIONS não chama atenderSondaOptions — o cron nunca atesta esta edge`);
    if (posCors < 0) throw new Error(`${edge}: a resposta de CORS do bloco OPTIONS mudou de forma — o preflight do browser tem de continuar idêntico`);
    if (posRamo > posCors) throw new Error(`${edge}: atenderSondaOptions está DEPOIS do return de CORS — código morto`);
    if (!/if \(sonda\) return sonda;/.test(corpo)) throw new Error(`${edge}: o resultado de atenderSondaOptions não é devolvido`);
    if ((corpo.match(/return /g) ?? []).length !== 2) throw new Error(`${edge}: o bloco OPTIONS tem de ter exatamente 2 returns (sonda e CORS)`);
    if (/req\.json\(|req\.text\(|createClient\(|fetch\(/.test(corpo)) throw new Error(`${edge}: IO dentro do bloco OPTIONS`);
  }
});
```

- [ ] **Step 2: Rodar e ver falhar** — `deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-versao-contrato_test.ts --filter "sonda por cron"` → FAIL `monthly-report: o bloco OPTIONS não chama atenderSondaOptions` (e `sonda-relay` já passa, da Task 3).

- [ ] **Step 3: Editar as 3 edges**

Em cada `index.ts`, acrescente ao import de `_shared` (uma linha nova, logo após a linha `import { authorizeCron… } from "../_shared/auth.ts";`):
```ts
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
```
e substitua o bloco `OPTIONS` pelo bloco da seção **Produces** acima (em `sync-reprocess` as aspas são duplas: `"OPTIONS"` — mantenha as aspas do arquivo).

Bumps em `versao.ts`: `monthly-report` → `export const VERSAO = "v1.1-sonda-options";` · `calculate-scores` → `"v1.1-sonda-options"` · `sync-reprocess` → `"v1.3-sonda-options"`.

- [ ] **Step 4: Rodar e ver passar** — o mesmo comando do Step 2 → PASS. Depois `bun run test:edges && bun run edges:typecheck && bun run sonda:bump && bun run sonda:fingerprint -- --write && bun run sonda:fingerprint` (o mapa muda para as 3 + relé; commite o mapa regenerado). `bun run test` (vitest) também — o `sonda-versao-sql.test.ts` e afins leem `versao.ts`.

- [ ] **Step 5: Commit do ramo (ANTES de gravar `desde`)**

```bash
git add supabase/functions/monthly-report supabase/functions/calculate-scores supabase/functions/sync-reprocess supabase/functions/_shared/sonda-versao-contrato_test.ts supabase/functions/_shared/sonda-fingerprints.ts
git commit -m "feat(sonda-cron): ramo OPTIONS autenticado em monthly-report, calculate-scores e sync-reprocess (bump); gate de contrato exige o ramo dentro do bloco OPTIONS"
```

- [ ] **Step 6: Gravar `desde` = sha desse commit e commitar**

```bash
SHA=$(git rev-parse --short=12 HEAD)
# em supabase/functions/_shared/sonda-cron-alvos.ts, troque `desde: null` por `desde: "<SHA>"` nas 4 entradas
sed -i '' "s/desde: null/desde: \"$SHA\"/g" supabase/functions/_shared/sonda-cron-alvos.ts
deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-cron-alvos_test.ts
git add supabase/functions/_shared/sonda-cron-alvos.ts && git commit -m "feat(sonda-cron): desde = sha do ramo nas 4 entradas da allowlist"
```
(O relé nasceu na Task 3, mas `desde` é "a partir de quando a alvo responde a sonda por OPTIONS"; usar o sha do ramo das pilotos para o relé é conservador: closures do relé anteriores a este sha, se existirem, têm de responder CORS — o que é verdade, o relé já nasceu com o ramo.)

- [ ] **Step 7: Falsificar o gate (após o commit)** — mova a linha `const sonda = …` para DEPOIS do `return new Response(null…)` em `monthly-report` → o gate tem de falhar com `monthly-report: atenderSondaOptions está DEPOIS do return de CORS`. Restaure: `git checkout -- supabase/functions/monthly-report/index.ts`.

### Task 5: o harness — stubs, gerador de import map e `runner.ts` (executa UM closure e conta efeito)

**Files:**
- Create: `supabase/harness-sonda-rollback/stubs/contador.ts`, `stubs/supabase.ts`, `stubs/std-serve.ts`, `stubs/resend.ts`, `stubs/anthropic.ts`, `stubs/web-push.ts`
- Create: `supabase/harness-sonda-rollback/mapa-imports.ts` (puro; usado pelo runner-test da Task 6 e pelo Bun da Task 7)
- Create: `supabase/harness-sonda-rollback/runner.ts`
- Test: `supabase/harness-sonda-rollback/mapa_imports_test.ts`, `supabase/harness-sonda-rollback/runner_test.ts` (sobre closures sintéticos em `sinteticos/`)

**Interfaces:**
- Produces:
  - `gerarImportMap(especificadores: string[], raizStubs: string): { imports: Record<string, string>; desconhecidos: string[] }` — casa por família: `supabase-js` (npm:/esm.sh, qualquer versão) → `stubs/supabase.ts`; `deno.land/std@*/http/server.ts` → `stubs/std-serve.ts`; `resend` (npm:/esm.sh) → `stubs/resend.ts`; `npm:@anthropic-ai/sdk*` → `stubs/anthropic.ts`; `npm:web-push*` → `stubs/web-push.ts`; qualquer outro → `desconhecidos`.
  - `extrairRemotos(fonte: string): string[]` — especificadores `npm:`/`https:`/`jsr:`/`node:` de um arquivo.
  - Protocolo do runner: `deno run --no-remote --import-map=<map> --allow-read=<raiz> runner.ts <index.ts> <edge> <chave-hmac> <controles-json>` → imprime **uma** linha JSON: `{ importErro, efeitosNoImport, a: Chamada, b: Chamada[], c: { classe: "sem-gate"|"controle"|"inconclusivo", efeitos, fetches, degrau }, chamadas: string[] }` onde `Chamada = { status, probe, efeitos, fetches, corpoHash, headers: Record<string,string> }`. `b` traz 4 entradas (ausente, hex inválido, valor errado, outra edge).

- [ ] **Step 1: contador + stubs**

```ts
// supabase/harness-sonda-rollback/stubs/contador.ts
export const contador = { efeitos: 0, fetches: 0, chamadas: [] as string[], fetchUrls: [] as string[] };
export function zerar() { contador.efeitos = 0; contador.fetches = 0; contador.chamadas.length = 0; contador.fetchUrls.length = 0; }
/** Proxy que conta TODA chamada de método/construtor como efeito e resolve `await` como {data:[],error:null}. */
export function proxy(caminho: string): unknown {
  const alvo = function () {};
  return new Proxy(alvo, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null, count: 0, status: 200 });
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "toJSON") return () => caminho;
      return proxy(`${caminho}.${String(prop)}`);
    },
    apply(_t, _this, _args) { contador.efeitos++; contador.chamadas.push(caminho); return proxy(caminho + "()"); },
    construct(_t, _args) { contador.efeitos++; contador.chamadas.push("new " + caminho); return proxy(caminho + "#") as object; },
  });
}
```
```ts
// supabase/harness-sonda-rollback/stubs/supabase.ts
import { proxy } from "./contador.ts";
export function createClient(..._a: unknown[]) { return proxy("client"); }   // criar o client NÃO conta
export default { createClient };
```
```ts
// supabase/harness-sonda-rollback/stubs/std-serve.ts
export function serve(a: unknown, b?: unknown) { (globalThis as Record<string, unknown>).__handler = typeof a === "function" ? a : b; return {}; }
export default serve;
```
```ts
// supabase/harness-sonda-rollback/stubs/resend.ts
import { proxy } from "./contador.ts";
export class Resend { constructor(..._a: unknown[]) { return proxy("resend") as unknown as Resend; } }
export default Resend;
```
```ts
// supabase/harness-sonda-rollback/stubs/anthropic.ts
import { proxy } from "./contador.ts";
export default class Anthropic { constructor(..._a: unknown[]) { return proxy("anthropic") as unknown as Anthropic; } }
export { Anthropic };
```
```ts
// supabase/harness-sonda-rollback/stubs/web-push.ts
import { proxy } from "./contador.ts";
export const sendNotification = proxy("webpush.sendNotification");
export const setVapidDetails = () => {};   // configuração, não efeito
export default { sendNotification, setVapidDetails };
```

- [ ] **Step 2: gerador de import map + teste**

```ts
// supabase/harness-sonda-rollback/mapa-imports.ts — puro (roda em Deno e em Bun)
const REM = /\bfrom\s+['"]((?:npm:|https?:\/\/|jsr:|node:)[^'"]+)['"]|\bimport\s+['"]((?:npm:|https?:\/\/|jsr:|node:)[^'"]+)['"]/g;
export function extrairRemotos(fonte: string): string[] {
  const out = new Set<string>();
  for (const m of fonte.matchAll(REM)) out.add(m[1] ?? m[2]);
  return [...out].sort();
}
const FAMILIAS: Array<[RegExp, string]> = [
  [/^(npm:|https:\/\/esm\.sh\/)@supabase\/supabase-js(@|$)/, "supabase.ts"],
  [/^https:\/\/deno\.land\/std@[^/]+\/http\/server\.ts$/, "std-serve.ts"],
  [/^(npm:|https:\/\/esm\.sh\/)resend(@|$)/, "resend.ts"],
  [/^npm:@anthropic-ai\/sdk(@|$)/, "anthropic.ts"],
  [/^npm:web-push(@|$)/, "web-push.ts"],
];
export function gerarImportMap(especificadores: string[], raizStubs: string): { imports: Record<string, string>; desconhecidos: string[] } {
  const imports: Record<string, string> = {}; const desconhecidos: string[] = [];
  for (const e of especificadores) {
    const fam = FAMILIAS.find(([re]) => re.test(e));
    if (fam) imports[e] = `${raizStubs.replace(/\/$/, "")}/${fam[1]}`; else desconhecidos.push(e);
  }
  return { imports, desconhecidos };
}
```
```ts
// supabase/harness-sonda-rollback/mapa_imports_test.ts
import { extrairRemotos, gerarImportMap } from "./mapa-imports.ts";
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }
Deno.test("mapa-imports: as 5 famílias medidas casam; o desconhecido é nomeado (fail-closed)", () => {
  const fonte = `import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";\nimport { serve } from "https://deno.land/std@0.190.0/http/server.ts";\nimport { Resend } from "npm:resend@2.0.0";\nimport Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";\nimport webpush from "npm:web-push@3.6.7";\nimport x from "npm:desconhecido@1";\nimport { y } from "./local.ts";`;
  const r = gerarImportMap(extrairRemotos(fonte), "file:///s");
  eq(Object.keys(r.imports).length, 5, "5 mapeados");
  eq(r.imports["npm:resend@2.0.0"], "file:///s/resend.ts", "resend");
  eq(r.imports["https://esm.sh/@supabase/supabase-js@2.49.1"], "file:///s/supabase.ts", "supabase esm.sh");
  eq(r.desconhecidos, ["npm:desconhecido@1"], "desconhecido nomeado");
});
```

- [ ] **Step 3: `runner.ts`**

```ts
// supabase/harness-sonda-rollback/runner.ts — executa UM closure materializado e conta efeito.
// Protocolo (spec v5 §4.4 passo 3): (a) OPTIONS do relé; (b) 4 negativos da credencial;
// (c) escada de controles positivos. Relógio virtual: timers e waitUntil são enfileirados e
// drenados até a quiescência antes de ler os contadores. Contador > 0 no import = FALHA.
import { contador, zerar } from "./stubs/contador.ts";
import { derivarCredencial, montarRequestSonda } from "../functions/_shared/sonda-cron.ts";

const [entrada, edge, chave, controlesJson] = Deno.args;
type Controle = { metodo: "POST"; headers: Record<string, string>; corpo: string | null; nota: string };
const controles: Controle[] = JSON.parse(controlesJson ?? "[]");
const ENV: Record<string, string> = {
  CRON_SECRET: "cron-secret-de-teste", SONDA_HMAC_KEY: chave, SUPABASE_URL: "http://projeto.local",
  SUPABASE_SERVICE_ROLE_KEY: "srk-de-teste", SUPABASE_ANON_KEY: "anon-de-teste", OMIE_WEBHOOK_SECRET: "webhook-de-teste",
};
const g = globalThis as Record<string, unknown>;
// ---- relógio virtual --------------------------------------------------------------------
const fila: Array<() => unknown> = [];
let tarefasExecutadas = 0; const TETO = 10_000;
(g as { setTimeout: unknown }).setTimeout = ((fn: () => unknown) => { fila.push(fn); return fila.length; }) as unknown;
(g as { setInterval: unknown }).setInterval = ((fn: () => unknown) => { fila.push(fn); return fila.length; }) as unknown;
(g as { clearTimeout: unknown }).clearTimeout = () => {}; (g as { clearInterval: unknown }).clearInterval = () => {};
g.EdgeRuntime = { waitUntil: (p: unknown) => { fila.push(() => p); } };
async function drenar(): Promise<boolean> {
  while (fila.length) {
    if (++tarefasExecutadas > TETO) return false;
    const t = fila.shift()!;
    try { await t(); } catch { /* efeito já contado pelos stubs; erro não é evidência de inocência */ }
    await Promise.resolve();
  }
  return true;
}
// ---- patches antes do import -------------------------------------------------------------
(Deno as unknown as { serve: unknown }).serve = (a: unknown, b?: unknown) => { g.__handler = typeof a === "function" ? a : b; return {}; };
(Deno.env as unknown as { get: unknown }).get = (k: string) => ENV[k] ?? `stub-${k}`;
g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = new Request(input, init); contador.fetches++; contador.fetchUrls.push(`${r.method} ${r.url}`);
  throw new Error("fetch bloqueado pelo harness");
};
let importErro: string | null = null;
try { await import("file://" + entrada); } catch (e) { importErro = String((e as Error)?.message ?? e).slice(0, 200); }
const efeitosNoImport = contador.efeitos + contador.fetches;
const h = g.__handler as ((r: Request) => Promise<Response>) | undefined;
const url = `${ENV.SUPABASE_URL}/functions/v1/${edge}`;
async function sha256(s: string) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function chamar(req: Request) {
  zerar(); let status = -1, corpo = "", headers: Record<string, string> = {};
  try { const r = await h!(req); status = r.status; corpo = await r.text(); headers = Object.fromEntries([...r.headers.entries()].sort()); } catch (e) { corpo = `__erro__:${String((e as Error)?.message ?? e).slice(0, 80)}`; }
  const quiesceu = await drenar();
  return { status, probe: /"probe"\s*:\s*true/.test(corpo), efeitos: contador.efeitos, fetches: contador.fetches, corpoHash: await sha256(corpo), headers, quiesceu };
}
function resolver(v: string) { return v.replace(/\$([A-Z_]+)/g, (_, n) => ENV[n] ?? `stub-${n}`); }
const out: Record<string, unknown> = { entrada, edge, importErro, efeitosNoImport, handler: !!h };
if (h) {
  const cred = await derivarCredencial(chave, edge);
  out.a = await chamar(montarRequestSonda(ENV.SUPABASE_URL, edge, cred));
  const negativos: Array<[string, Record<string, string>]> = [
    ["ausente", { "Origin": "https://app", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-sonda-credencial" }],
    ["hex-invalido", { "x-sonda-credencial": "zz" + cred.slice(2) }],
    ["errada", { "x-sonda-credencial": await derivarCredencial(chave + "x", edge) }],
    ["outra-edge", { "x-sonda-credencial": await derivarCredencial(chave, edge + "-outra") }],
  ];
  out.b = [];
  for (const [nome, headers] of negativos) (out.b as unknown[]).push({ nome, ...(await chamar(new Request(url, { method: "OPTIONS", headers }))) });
  // (c) escada: sem credencial primeiro (classe sem-gate), depois cada controle declarado
  const escada: Array<[string, Controle]> = [["sem-credencial", { metodo: "POST", headers: { "content-type": "application/json" }, corpo: "{}", nota: "" }], ...controles.map((c, i): [string, Controle] => [`controle-${i}`, c])];
  let c: Record<string, unknown> = { classe: "inconclusivo", efeitos: 0, fetches: 0, degrau: null };
  for (const [nome, ctl] of escada) {
    const headers = Object.fromEntries(Object.entries(ctl.headers).map(([k, v]) => [k, resolver(v)]));
    const r = await chamar(new Request(url, { method: ctl.metodo, headers, body: ctl.corpo }));
    if (r.efeitos + r.fetches > 0) { c = { classe: nome === "sem-credencial" ? "sem-gate" : "controle", efeitos: r.efeitos, fetches: r.fetches, degrau: nome }; break; }
  }
  out.c = c; out.chamadas = contador.chamadas.slice(0, 12); out.fetchUrls = contador.fetchUrls.slice(0, 6);
}
console.log(JSON.stringify(out));
```

- [ ] **Step 4: closures sintéticos e o teste do runner**

Crie `supabase/harness-sonda-rollback/sinteticos/<nome>/index.ts` (cada um importa `npm:@supabase/supabase-js@2` e é servido por `Deno.serve`) — os que têm de dar `FALHA` em (a): `io-top-level` (`await createClient("u","k").from("t").select("*")` no topo do módulo), `io-antes-do-metodo` (`await c.from("t").select()` antes do `if (req.method === "OPTIONS")`), `helper-no-ramo` (o bloco OPTIONS chama `await auditar()` que faz `.from().insert()`), `fallthrough` (bloco OPTIONS sem `return`, e o fluxo real abaixo faz `.from().select()`), `assincrono-antes-do-return` (`setTimeout(() => c.from("t").insert({}), 50)` antes do `return` do CORS), `header-qualquer` (responde `{"probe":true,…}` a qualquer `OPTIONS` com header presente, sem verificar); e os que têm de dar `PASSA`: `gate-ignorado` (chama `authorize` e ignora o resultado, mas OPTIONS-primeiro), `ramo-morto` (gate atrás de `if (false)`, OPTIONS-primeiro), `padrao` (OPTIONS → gate por `x-cron-secret` → `.from().select()`).

```ts
// supabase/harness-sonda-rollback/runner_test.ts
import { gerarImportMap } from "./mapa-imports.ts";
const RAIZ = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
async function correr(nome: string) {
  const mapa = gerarImportMap(["npm:@supabase/supabase-js@2"], `file://${RAIZ}/stubs`);
  const mapaPath = await Deno.makeTempFile({ suffix: ".json" }); await Deno.writeTextFile(mapaPath, JSON.stringify(mapa));
  const cmd = new Deno.Command("deno", { args: ["run", "--no-remote", `--import-map=${mapaPath}`, `--allow-read=${RAIZ}`, `${RAIZ}/runner.ts`, `${RAIZ}/sinteticos/${nome}/index.ts`, nome, "u".repeat(44), JSON.stringify([{ metodo: "POST", headers: { "content-type": "application/json", "x-cron-secret": "$CRON_SECRET" }, corpo: "{}", nota: "padrão" }])] });
  const o = await cmd.output(); const linha = new TextDecoder().decode(o.stdout).trim().split("\n").pop()!;
  return JSON.parse(linha);
}
function inerte(r: { a: { efeitos: number; fetches: number; probe: boolean }; b: Array<{ efeitos: number; fetches: number }>; efeitosNoImport: number }) {
  return r.efeitosNoImport === 0 && r.a.efeitos === 0 && r.a.fetches === 0 && !r.a.probe && r.b.every((x) => x.efeitos === 0 && x.fetches === 0);
}
Deno.test("runner: os sintéticos do OPTIONS reprovam; os inofensivos passam com controle positivo", async () => {
  for (const nome of ["io-top-level", "io-antes-do-metodo", "helper-no-ramo", "fallthrough", "assincrono-antes-do-return", "header-qualquer"]) {
    if (inerte(await correr(nome))) throw new Error(`${nome}: tinha de reprovar e passou (o runner não enxerga esta forma)`);
  }
  for (const nome of ["gate-ignorado", "ramo-morto", "padrao"]) {
    const r = await correr(nome);
    if (!inerte(r)) throw new Error(`${nome}: é seguro ao OPTIONS e o runner reprovou`);
    if (r.c.classe === "inconclusivo") throw new Error(`${nome}: controle positivo inconclusivo — o contador não vê o fluxo real`);
  }
});
```

- [ ] **Step 5: Rodar** — `deno test --no-remote --allow-read=supabase --allow-write=/tmp --allow-run=deno supabase/harness-sonda-rollback/mapa_imports_test.ts supabase/harness-sonda-rollback/runner_test.ts` → `2 passed`. (`--allow-write` só para o import map temporário; nada de `--allow-net`.)

- [ ] **Step 6: Commit** — `git add supabase/harness-sonda-rollback && git commit -m "feat(harness-sonda): runner com relógio virtual, stubs por família e gerador de import map; sintéticos do OPTIONS reprovam"`

### Task 6: o teste sempre-on de rollback (`rollback_test.ts`) + script + step de CI

**Files:**
- Create: `supabase/harness-sonda-rollback/materializar.ts` (Deno: `git archive` de um closure para um dir temporário + import map)
- Create: `supabase/harness-sonda-rollback/rollback_test.ts`
- Modify: `package.json` (script `test:sonda-rollback`), `.github/workflows/ci.yml` (step após `Tests (edge functions — Deno, offline)`)

**Interfaces:**
- Consumes: `runner.ts` (protocolo da Task 5), `gerarImportMap`/`extrairRemotos` (Task 5), `derivarCredencial` (Task 1), `SONDA_CRON_ALVOS` (Task 2).
- Produces: `materializar(sha: string, edge: string, raizRepo: string): Promise<{ dir: string; indexPath: string; mapaPath: string; desconhecidos: string[] }>` e `executarRunner(indexPath, mapaPath, edge, chave, controles): Promise<Veredito>` — reutilizados pela Task 7 via subprocesso (o Bun chama `deno run materializar.ts`? não: o Bun tem o próprio `git archive`; o que é compartilhado é `mapa-imports.ts`).

- [ ] **Step 1: `materializar.ts`**

```ts
// supabase/harness-sonda-rollback/materializar.ts — bundle histórico REAL, direto do git.
import { extrairRemotos, gerarImportMap } from "./mapa-imports.ts";
const RAIZ = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
async function sh(args: string[], cwd: string): Promise<Uint8Array> {
  const o = await new Deno.Command(args[0], { args: args.slice(1), cwd, stdout: "piped", stderr: "piped" }).output();
  if (!o.success) throw new Error(`${args.join(" ")} falhou: ${new TextDecoder().decode(o.stderr).slice(0, 200)}`);
  return o.stdout;
}
export async function materializar(sha: string, edge: string, raizRepo: string) {
  const dir = await Deno.makeTempDir({ prefix: `closure-${edge}-${sha}-` });
  const tar = await sh(["git", "archive", sha, `supabase/functions/${edge}`, "supabase/functions/_shared"], raizRepo);
  const tarPath = `${dir}/closure.tar`; await Deno.writeFile(tarPath, tar);
  await sh(["tar", "-x", "-C", dir, "-f", tarPath], raizRepo);
  const remotos = new Set<string>();
  for await (const e of percorrer(`${dir}/supabase/functions`)) if (e.endsWith(".ts")) for (const r of extrairRemotos(await Deno.readTextFile(e))) remotos.add(r);
  const mapa = gerarImportMap([...remotos].sort(), `file://${RAIZ}/stubs`);
  const mapaPath = `${dir}/import_map.json`; await Deno.writeTextFile(mapaPath, JSON.stringify(mapa, null, 1));
  return { dir, indexPath: `${dir}/supabase/functions/${edge}/index.ts`, mapaPath, desconhecidos: mapa.desconhecidos };
}
async function* percorrer(d: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(d)) { const p = `${d}/${e.name}`; if (e.isDirectory) yield* percorrer(p); else yield p; }
}
export type Veredito = { importErro: string | null; efeitosNoImport: number; handler: boolean; a: Chamada; b: Array<Chamada & { nome: string }>; c: { classe: string; efeitos: number; fetches: number; degrau: string | null }; chamadas: string[]; fetchUrls: string[] };
export type Chamada = { status: number; probe: boolean; efeitos: number; fetches: number; corpoHash: string; headers: Record<string, string>; quiesceu: boolean };
export async function executarRunner(indexPath: string, mapaPath: string, edge: string, chave: string, controles: unknown): Promise<Veredito> {
  const o = await new Deno.Command("deno", { args: ["run", "--no-remote", `--import-map=${mapaPath}`, `--allow-read=${RAIZ},${indexPath.replace(/\/supabase\/functions\/.*$/, "")}`, `${RAIZ}/runner.ts`, indexPath, edge, chave, JSON.stringify(controles)], stdout: "piped", stderr: "piped" }).output();
  const linhas = new TextDecoder().decode(o.stdout).trim().split("\n");
  const ultima = linhas[linhas.length - 1] ?? "";
  if (!ultima.startsWith("{")) throw new Error(`runner sem veredito para ${edge}: ${new TextDecoder().decode(o.stderr).slice(0, 300)}`);
  return JSON.parse(ultima);
}
```

- [ ] **Step 2: `rollback_test.ts` (falha antes das Tasks 3–4 estarem no HEAD)**

```ts
// supabase/harness-sonda-rollback/rollback_test.ts — o teste DECISIVO (spec v5 §5).
// Roda com: bun run test:sonda-rollback
import { executarRunner, materializar, type Veredito } from "./materializar.ts";
import { derivarCredencial, HEADER_SONDA } from "../functions/_shared/sonda-cron.ts";
import { SONDA_CRON_ALVOS } from "../functions/_shared/sonda-cron-alvos.ts";
const RAIZ = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const REPO = RAIZ.replace(/\/supabase\/harness-sonda-rollback$/, "");
const CHAVE = "u".repeat(44);
function assert(c: unknown, m: string) { if (!c) throw new Error(m); }
function controlesDe(edge: string) { return SONDA_CRON_ALVOS.find((a) => a.edge === edge)!.controles; }
function inerte(v: Veredito, rotulo: string) {
  assert(v.importErro === null && v.handler, `${rotulo}: closure INVERIFICAVEL (${v.importErro ?? "sem handler"})`);
  assert(v.efeitosNoImport === 0, `${rotulo}: IO no import (${v.efeitosNoImport})`);
  assert(v.a.status >= 200 && v.a.status < 300 && v.a.efeitos === 0 && v.a.fetches === 0 && v.a.quiesceu, `${rotulo}: (a) OPTIONS do relé produziu efeito/fetch ou não quiesceu: ${JSON.stringify(v.a)}`);
  for (const b of v.b) assert(b.efeitos === 0 && b.fetches === 0 && b.corpoHash === v.b[0].corpoHash && b.status === v.b[0].status, `${rotulo}: negativo ${b.nome} produziu efeito ou resposta diferente do preflight`);
}
const VELHAS: Array<[string, string, string]> = [
  ["monthly-report", "ef08dddd2", "SEM gate (2026-02): contraexemplo do Codex"],
  ["monthly-report", "81f9a111c", "pré-sensor com gate"],
  ["monthly-report", "0ed5a9b31", "intermediário: classificador após o gate, sem credencial"],
  ["calculate-scores", "45a80118b", "SEM gate (2026-03): contraexemplo do Codex"],
  ["calculate-scores", "d33c83836", "pré-sensor com gate"],
];
Deno.test("bundles VELHOS: o OPTIONS do relé e os 4 negativos são inertes; o controle positivo produz efeito", async () => {
  for (const [edge, sha, rotulo] of VELHAS) {
    const m = await materializar(sha, edge, REPO);
    assert(m.desconhecidos.length === 0, `${edge}@${sha}: especificador fora do catálogo: ${m.desconhecidos.join(",")}`);
    const v = await executarRunner(m.indexPath, m.mapaPath, edge, CHAVE, controlesDe(edge));
    inerte(v, `${edge}@${sha} (${rotulo})`);
    assert(!v.a.probe, `${edge}@${sha}: respondeu probe sem ter o ramo`);
    assert(v.c.classe !== "inconclusivo", `${edge}@${sha}: controle positivo inconclusivo — o contador não vê o fluxo real deste bundle`);
    if (sha === "ef08dddd2" || sha === "45a80118b") assert(v.c.classe === "sem-gate", `${edge}@${sha}: era para produzir efeito SEM credencial (classe sem-gate), veio ${v.c.classe}`);
    await Deno.remove(m.dir, { recursive: true });
  }
});
Deno.test("bundle ATUAL: o OPTIONS do relé atesta com o contrato completo; os negativos são o CORS de hoje; controle positivo", async () => {
  for (const edge of ["monthly-report", "calculate-scores", "sync-reprocess"]) {
    const v = await executarRunner(`${REPO}/supabase/functions/${edge}/index.ts`, `${RAIZ}/import_map.json`, edge, CHAVE, controlesDe(edge));
    assert(v.importErro === null && v.efeitosNoImport === 0, `${edge}: import`);
    assert(v.a.status === 200 && v.a.probe && v.a.efeitos === 0 && v.a.fetches === 0, `${edge}: (a) atual não atestou sem efeito: ${JSON.stringify(v.a)}`);
    for (const b of v.b) assert(b.efeitos === 0 && !b.probe && b.status === 200 && b.corpoHash === v.b[0].corpoHash, `${edge}: negativo ${b.nome} — tinha de ser o CORS de hoje`);
    assert(v.c.classe !== "inconclusivo", `${edge}: controle inconclusivo`);
  }
});
Deno.test("relé: o POST operacional emite exatamente UM fetch OPTIONS (replay da prova histórica do relé)", async () => {
  const v = await executarRunner(`${REPO}/supabase/functions/sonda-relay/index.ts`, `${RAIZ}/import_map.json`, "sonda-relay", CHAVE, controlesDe("sonda-relay"));
  assert(v.a.status === 200 && v.a.probe && v.a.efeitos === 0, "relé: (a) própria sonda");
  assert(v.c.classe === "controle" && v.c.fetches === 1 && v.c.efeitos === 0, `relé: controle = 1 fetch de saída, 0 efeitos: ${JSON.stringify(v.c)}`);
  assert(v.fetchUrls[0] === "OPTIONS http://projeto.local/functions/v1/monthly-report", `relé: fetch de saída não é OPTIONS na alvo: ${v.fetchUrls[0]}`);
});
Deno.test("paridade HMAC: vetores fixos", async () => {
  assert((await derivarCredencial("Jefe", "monthly-report")) === "04855b66e0237a22cb2039fa2859d597b90adf29ee61ce9cd2f3d03c37e7ce42", "vetor monthly-report");
  assert(HEADER_SONDA === "x-sonda-credencial", "nome do header");
});
```
Crie também `supabase/harness-sonda-rollback/import_map.json` para o bundle ATUAL: `{"imports": {"npm:@supabase/supabase-js@2": "./stubs/supabase.ts"}}` (as 3 pilotos e o relé só importam isso de remoto; se o `test:sonda-rollback` acusar `Module not found` para outro especificador, acrescente-o com o stub da família).

- [ ] **Step 3: script + CI**

`package.json` (junto de `test:edges`): `"test:sonda-rollback": "deno test --no-remote --allow-read=. --allow-write=/tmp,/private/tmp --allow-run=deno,git,tar supabase/harness-sonda-rollback/"`.

`.github/workflows/ci.yml`, logo após o step `Tests (edge functions — Deno, offline)`:
```yaml
      # Teste DECISIVO da sonda por cron (spec 2026-09-05-sonda-por-cron-fail-closed-design.md §5):
      # materializa bundles históricos REAIS (git archive) — inclusive os SEM gate que o Codex
      # nomeou — e prova que o OPTIONS do relé não produz efeito, com controle positivo. Precisa
      # de fetch-depth 0 (já é) e de `deno`/`git`/`tar`; sem rede (--no-remote).
      - name: Sonda por cron — rollback para bundle velho fica em ZERO efeito (Deno, offline)
        run: bun run test:sonda-rollback
```

- [ ] **Step 4: Rodar** — `bun run test:sonda-rollback` → `4 passed`; capture o `exit 0`.

- [ ] **Step 5: Falsificar (após commit)** — (S1) em `montarRequestSonda`, troque `METODO_SONDA` por `"POST"` → o teste dos bundles velhos tem de falhar em `monthly-report@ef08dddd2` com "(a) OPTIONS do relé produziu efeito"; (S2) em `stubs/contador.ts`, faça `apply` não incrementar → "controle positivo inconclusivo"; (S3) no `atenderSondaOptions`, remova a verificação (`return` a sonda para qualquer header) → "negativo hex-invalido — tinha de ser o CORS de hoje". Restaure com `git checkout --` a cada uma. Registre as 3 mensagens no corpo do PR.

- [ ] **Step 6: Commit** — `git add supabase/harness-sonda-rollback package.json .github/workflows/ci.yml && git commit -m "test(sonda-cron): teste decisivo de rollback — bundles reais sem gate ficam em zero efeito ao OPTIONS do relé; step blocking no CI"`

### Task 7: `scripts/sonda-cron-prova.ts` — a prova por execução de cada closure histórico (cache, gates, backfill)

**Files:**
- Create: `scripts/sonda-cron-prova.ts`, `scripts/sonda-cron-prova.test.ts` (vitest, funções puras), `supabase/functions/_shared/sonda-cron-prova.json` (gerado pelo backfill)
- Modify: `package.json` (`sonda:cron-prova`), `.github/workflows/ci.yml` (step após o da Task 6), `knip.json` só se acusar (o script é entry via `package.json`)

**Interfaces:**
- Consumes: `fecharGrafo`, `digerir`, `extrairImportsLocais` de `scripts/sonda-fingerprint.ts`; `gerarImportMap`, `extrairRemotos` de `supabase/harness-sonda-rollback/mapa-imports.ts` (import relativo `../supabase/harness-sonda-rollback/mapa-imports.ts` — arquivo puro, compila no `tsc` de scripts); `SONDA_CRON_ALVOS` via leitura do arquivo? **Não**: o Bun importa `../supabase/functions/_shared/sonda-cron-alvos.ts` diretamente (não tem `Deno.*`).
- Produces (exportadas, testadas no vitest): `enumerarClosures(edge, raiz): Array<{ sha: string; arquivos: string[]; identidade: string }>` (ponto fixo); `identidadeDoHarness(raiz): string`; `chaveDoManifesto(identidade, harness): string`; `classificarVeredito(v: Veredito, desde: string | null, shaEhPosDesde: boolean): "PASSA" | "FALHA" | "INVERIFICAVEL"`; `gateG1(edge, codigoIndex): string | null`; `gateG3(codigoRele): string | null`; `gateG4(migrations: Array<{ nome: string; sql: string }>, allowlist: string[]): string | null`; `main(argv): number` com modos `--backfill <edge|--tudo>`, `--gate` (CI), `--falsificar`.
- Manifesto: `{ "harness": "<hash>", "vereditos": { "<edge>": { "<identidade>": { "sha": "…", "veredito": "PASSA"|"FALHA"|"INVERIFICAVEL", "motivo": "…", "controle": "sem-gate"|"controle"|"inconclusivo", "em": "<iso>" } } } }` — ordenado, 1 entrada por identidade de closure.

- [ ] **Step 1: testes vitest das funções puras (falham)**

```ts
// scripts/sonda-cron-prova.test.ts
import { describe, expect, it } from 'vitest';
import { chaveDoManifesto, classificarVeredito, gateG1, gateG3, gateG4, pontoFixoDeArquivos } from './sonda-cron-prova';

const OPTIONS_OK = `Deno.serve(async (req) => {\n  if (req.method === 'OPTIONS') {\n    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);\n    if (sonda) return sonda;\n    return new Response(null, { headers: corsHeaders });\n  }\n  const auth = await authorizeCronOrStaff(req);`;

describe('gateG1 — o ramo dentro do bloco OPTIONS, antes do CORS', () => {
  it('aceita a forma canônica', () => expect(gateG1('monthly-report', OPTIONS_OK)).toBeNull());
  it('reprova ramo ausente, nomeando a edge', () => expect(gateG1('monthly-report', OPTIONS_OK.replace(/const sonda[^\n]*\n\s*if \(sonda\) return sonda;\n/, ''))).toMatch(/monthly-report.*atenderSondaOptions/));
  it('reprova ramo depois do return de CORS', () => {
    const invertido = OPTIONS_OK.replace('    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);\n    if (sonda) return sonda;\n    return new Response(null, { headers: corsHeaders });', '    return new Response(null, { headers: corsHeaders });\n    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);\n    if (sonda) return sonda;');
    expect(gateG1('monthly-report', invertido)).toMatch(/DEPOIS/);
  });
});
describe('gateG3 — o relé só emite OPTIONS', () => {
  const rele = `import { montarRequestSonda, barreiraSaida } from "../_shared/sonda-cron.ts";\nconst saida = montarRequestSonda(baseUrl, alvo, cred);\nconst v = barreiraSaida(saida, baseUrl, alvo, ALLOWLIST);\nresposta = await fetch(saida, { signal: AbortSignal.timeout(TIMEOUT_MS) });`;
  it('aceita um fetch sobre o request de montarRequestSonda com barreira', () => expect(gateG3(rele)).toBeNull());
  it('reprova 2 fetch', () => expect(gateG3(rele + '\nawait fetch(outra);')).toMatch(/fetch/));
  it('reprova method: literal e x-cron-secret na saída', () => {
    expect(gateG3(rele.replace('fetch(saida,', 'fetch(saida, { method: "POST" },'))).toMatch(/method/);
    expect(gateG3(rele + '\nheaders["x-cron-secret"] = s;')).toMatch(/x-cron-secret/);
  });
});
describe('gateG4 — o espelho no banco só nomeia slugs da allowlist', () => {
  it('reprova INSERT com slug fora', () => expect(gateG4([{ nome: 'm.sql', sql: "INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES ('omie-webhook', 'x')" }], ['monthly-report'])).toMatch(/omie-webhook/));
  it('aceita slug da allowlist e migrations sem a tabela', () => expect(gateG4([{ nome: 'm.sql', sql: "INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES ('monthly-report', 'x')" }, { nome: 'n.sql', sql: 'CREATE TABLE x()' }], ['monthly-report'])).toBeNull());
});
describe('classificarVeredito', () => {
  const base = { importErro: null, efeitosNoImport: 0, handler: true, a: { status: 200, probe: false, efeitos: 0, fetches: 0, corpoHash: 'h', headers: {}, quiesceu: true }, b: [0, 1, 2, 3].map((i) => ({ nome: String(i), status: 200, probe: false, efeitos: 0, fetches: 0, corpoHash: 'h', headers: {}, quiesceu: true })), c: { classe: 'controle', efeitos: 2, fetches: 0, degrau: 'controle-0' }, chamadas: [], fetchUrls: [] };
  it('PASSA quando inerte com controle', () => expect(classificarVeredito(base, 'abc', false)).toBe('PASSA'));
  it('FALHA com efeito no OPTIONS, no import, negativo diferente do preflight, ou probe antes do desde', () => {
    expect(classificarVeredito({ ...base, a: { ...base.a, efeitos: 1 } }, 'abc', false)).toBe('FALHA');
    expect(classificarVeredito({ ...base, efeitosNoImport: 1, importErro: 'x' }, 'abc', false)).toBe('FALHA');
    expect(classificarVeredito({ ...base, b: [...base.b.slice(0, 3), { ...base.b[3], corpoHash: 'outro' }] }, 'abc', false)).toBe('FALHA');
    expect(classificarVeredito({ ...base, a: { ...base.a, probe: true } }, 'abc', false)).toBe('FALHA');
  });
  it('a partir do desde, o OPTIONS TEM de atestar', () => expect(classificarVeredito(base, 'abc', true)).toBe('FALHA'));
  it('INVERIFICAVEL: import falhou sem efeito, ou controle inconclusivo', () => {
    expect(classificarVeredito({ ...base, importErro: 'Module not found', handler: false }, 'abc', false)).toBe('INVERIFICAVEL');
    expect(classificarVeredito({ ...base, c: { classe: 'inconclusivo', efeitos: 0, fetches: 0, degrau: null } }, 'abc', false)).toBe('INVERIFICAVEL');
  });
});
describe('pontoFixoDeArquivos e chave do manifesto', () => {
  it('a chave muda com o harness', () => expect(chaveDoManifesto('c1', 'h1')).not.toBe(chaveDoManifesto('c1', 'h2')));
  it('o ponto fixo une os fechos de cada sha até estabilizar', () => {
    const fechos: Record<string, string[]> = { s1: ['a/index.ts', '_shared/x.ts'], s2: ['a/index.ts', '_shared/velho.ts'] };
    const historico = (files: string[]) => files.includes('_shared/velho.ts') ? ['s1', 's2'] : ['s1'];
    expect(pontoFixoDeArquivos(['a/index.ts'], historico, (sha) => fechos[sha])).toEqual({ arquivos: ['_shared/velho.ts', '_shared/x.ts', 'a/index.ts'], shas: ['s1', 's2'] });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `bun run test -- scripts/sonda-cron-prova.test.ts` → `Cannot find module './sonda-cron-prova'`.

- [ ] **Step 3: Implementar o script**

```ts
#!/usr/bin/env bun
/**
 * sonda-cron-prova.ts — a PROVA da allowlist da sonda por cron: executa cada closure histórico
 * de cada edge da allowlist com o OPTIONS do relé e conta efeito (spec v5 §4.4). Texto não prova
 * (spike 2026-09-05: critério textual reprovou 37/54 por ruído E deixaria passar bundle sem gate).
 *
 *   bun scripts/sonda-cron-prova.ts --backfill <edge> | --backfill --tudo   (executa e grava o manifesto)
 *   bun scripts/sonda-cron-prova.ts --gate            (CI: G1..G4 + cobertura + re-execução do que mudou)
 *   bun scripts/sonda-cron-prova.ts --falsificar      (sintéticos do OPTIONS têm de sair FALHA)
 *
 * Exit: 0 ok · 1 FALHA/INVERIFICAVEL/gate reprovado · 2 mecânica (git raso, deno ausente, runner sem veredito).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digerir, extrairImportsLocais, fecharGrafo } from './sonda-fingerprint';
import { extrairRemotos, gerarImportMap } from '../supabase/harness-sonda-rollback/mapa-imports';
import { SONDA_CRON_ALVOS } from '../supabase/functions/_shared/sonda-cron-alvos';

const HARNESS = 'supabase/harness-sonda-rollback';
const MANIFESTO = 'supabase/functions/_shared/sonda-cron-prova.json';
const CHAVE_TESTE = 'u'.repeat(44);
type Veredito = { importErro: string | null; efeitosNoImport: number; handler: boolean; a: Chamada; b: Array<Chamada & { nome: string }>; c: { classe: string; efeitos: number; fetches: number; degrau: string | null }; chamadas: string[]; fetchUrls: string[] };
type Chamada = { status: number; probe: boolean; efeitos: number; fetches: number; corpoHash: string; headers: Record<string, string>; quiesceu: boolean };
type Classe = 'PASSA' | 'FALHA' | 'INVERIFICAVEL';
type Entrada = { sha: string; veredito: Classe; motivo: string; controle: string; em: string };
type Manifesto = { harness: string; vereditos: Record<string, Record<string, Entrada>> };

function git(args: string[], raiz: string): string {
  const r = spawnSync('git', args, { cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Mecanica(`git ${args.slice(0, 3).join(' ')} falhou: ${(r.stderr || '').slice(0, 200)}`);
  return r.stdout;
}
class Mecanica extends Error {}

/** Ponto fixo: F ← fecho no HEAD; repete { shas ← histórico de cada f (--follow, com renames); F ← F ∪ fechos(sha) } */
export function pontoFixoDeArquivos(inicial: string[], historico: (arquivos: string[]) => string[], fechoEm: (sha: string) => string[]): { arquivos: string[]; shas: string[] } {
  let arquivos = new Set(inicial); let shas = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const novosShas = historico([...arquivos]);
    const antes = arquivos.size; shas = new Set(novosShas);
    for (const sha of novosShas) for (const f of fechoEm(sha)) arquivos.add(f);
    if (arquivos.size === antes) break;
  }
  return { arquivos: [...arquivos].sort(), shas: [...shas] };
}
function historicoComRenames(arquivos: string[], raiz: string): string[] {
  const shas = new Set<string>();
  for (const f of arquivos) {
    // --follow aceita UM pathspec; --name-status expõe R100 velho novo (ambos entram no ponto fixo via fechoEm)
    const saida = spawnSync('git', ['log', '--follow', '--format=%H', '--name-status', '--', f], { cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (saida.status !== 0) throw new Mecanica(`git log --follow -- ${f}: ${saida.stderr.slice(0, 120)}`);
    for (const l of saida.stdout.split('\n')) if (/^[0-9a-f]{40}$/.test(l)) shas.add(l);
  }
  return [...shas];
}
function fechoNoSha(sha: string, edge: string, raiz: string): string[] {
  const vistos = new Set<string>(); const fila = [`supabase/functions/${edge}/index.ts`];
  while (fila.length) {
    const p = fila.pop()!; if (vistos.has(p)) continue;
    const r = spawnSync('git', ['show', `${sha}:${p}`], { cwd: raiz, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) continue;   // arquivo não existe naquele sha: não faz parte daquele fecho
    vistos.add(p);
    for (const esp of extrairImportsLocais(r.stdout)) fila.push(resolve('/', p, '..', esp).slice(1));
  }
  return [...vistos].sort();
}
export function enumerarClosures(edge: string, raiz = process.cwd()): Array<{ sha: string; arquivos: string[]; identidade: string }> {
  const inicial = fecharGrafo(`supabase/functions/${edge}/index.ts`, raiz);
  const { shas } = pontoFixoDeArquivos(inicial, (fs) => historicoComRenames(fs, raiz), (sha) => fechoNoSha(sha, edge, raiz));
  if (shas.length === 0) throw new Mecanica(`${edge}: 0 commits na história — checkout raso? (fetch-depth: 0)`);
  const porIdentidade = new Map<string, { sha: string; arquivos: string[]; identidade: string }>();
  for (const sha of shas) {
    const arquivos = fechoNoSha(sha, edge, raiz);
    if (!arquivos.includes(`supabase/functions/${edge}/index.ts`)) continue;   // a edge não existia neste commit
    const h = createHash('sha256');
    for (const a of arquivos) { const c = git(['show', `${sha}:${a}`], raiz); h.update(a).update('\0').update(String(Buffer.byteLength(c))).update('\0').update(c); }
    const identidade = h.digest('hex');
    if (!porIdentidade.has(identidade)) porIdentidade.set(identidade, { sha, arquivos, identidade });
  }
  return [...porIdentidade.values()];
}
export function identidadeDoHarness(raiz = process.cwd()): string {
  const arquivos = [`${HARNESS}/runner.ts`, `${HARNESS}/mapa-imports.ts`, 'supabase/functions/_shared/sonda-cron.ts', ...readdirSync(resolve(raiz, HARNESS, 'stubs')).sort().map((f) => `${HARNESS}/stubs/${f}`)];
  const deno = spawnSync('deno', ['--version'], { encoding: 'utf8' });
  if (deno.status !== 0) throw new Mecanica('deno ausente — a prova não pode rodar');
  return digerir(arquivos, raiz) + ':' + createHash('sha256').update(deno.stdout.split('\n')[0]).digest('hex').slice(0, 16);
}
export function chaveDoManifesto(identidade: string, harness: string): string { return `${identidade}@${harness}`; }
export function classificarVeredito(v: Veredito, desde: string | null, shaEhPosDesde: boolean): Classe {
  if (v.efeitosNoImport > 0) return 'FALHA';
  if (v.importErro !== null || !v.handler) return 'INVERIFICAVEL';
  const a = v.a;
  if (a.efeitos > 0 || a.fetches > 0 || !a.quiesceu || a.status < 200 || a.status >= 300) return 'FALHA';
  if (!v.b.every((b) => b.efeitos === 0 && b.fetches === 0 && b.quiesceu && b.corpoHash === v.b[0].corpoHash && b.status === v.b[0].status)) return 'FALHA';
  if (desde !== null && shaEhPosDesde ? !a.probe : a.probe) return 'FALHA';
  if (v.c.classe === 'inconclusivo') return 'INVERIFICAVEL';
  return 'PASSA';
}
function ehAncestral(desde: string, sha: string, raiz: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', desde, sha], { cwd: raiz }).status === 0;
}
function executar(edge: string, sha: string, raiz: string): Veredito {
  const dir = mkdtempSync(join(tmpdir(), `closure-${edge}-`));
  try {
    const tar = execFileSync('git', ['archive', sha, `supabase/functions/${edge}`, 'supabase/functions/_shared'], { cwd: raiz, maxBuffer: 256 * 1024 * 1024 });
    writeFileSync(join(dir, 'c.tar'), tar); execFileSync('tar', ['-x', '-C', dir, '-f', join(dir, 'c.tar')]);
    const remotos = new Set<string>();
    const percorrer = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) percorrer(p); else if (p.endsWith('.ts')) for (const r of extrairRemotos(readFileSync(p, 'utf8'))) remotos.add(r); } };
    percorrer(join(dir, 'supabase/functions'));
    const mapa = gerarImportMap([...remotos].sort(), `file://${resolve(raiz, HARNESS, 'stubs')}`);
    if (mapa.desconhecidos.length) return { importErro: `especificador fora do catálogo: ${mapa.desconhecidos.join(',')}`, efeitosNoImport: 0, handler: false } as Veredito;
    writeFileSync(join(dir, 'import_map.json'), JSON.stringify(mapa));
    const alvo = SONDA_CRON_ALVOS.find((a) => a.edge === edge)!;
    const r = spawnSync('deno', ['run', '--no-remote', `--import-map=${join(dir, 'import_map.json')}`, `--allow-read=${resolve(raiz, HARNESS)},${dir}`, resolve(raiz, HARNESS, 'runner.ts'), join(dir, 'supabase/functions', edge, 'index.ts'), edge, CHAVE_TESTE, JSON.stringify(alvo.controles)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    const linha = (r.stdout || '').trim().split('\n').pop() ?? '';
    if (!linha.startsWith('{')) throw new Mecanica(`runner sem veredito (${edge}@${sha}): ${(r.stderr || '').slice(0, 200)}`);
    return JSON.parse(linha);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function lerManifesto(raiz: string): Manifesto { return existsSync(resolve(raiz, MANIFESTO)) ? JSON.parse(readFileSync(resolve(raiz, MANIFESTO), 'utf8')) : { harness: '', vereditos: {} }; }
function gravarManifesto(m: Manifesto, raiz: string) { const ord: Manifesto = { harness: m.harness, vereditos: {} }; for (const e of Object.keys(m.vereditos).sort()) { ord.vereditos[e] = {}; for (const k of Object.keys(m.vereditos[e]).sort()) ord.vereditos[e][k] = m.vereditos[e][k]; } writeFileSync(resolve(raiz, MANIFESTO), JSON.stringify(ord, null, 1) + '\n'); }

export function gateG1(edge: string, codigo: string): string | null {
  const i = codigo.indexOf('Deno.serve('); if (i < 0) return `${edge}: Deno.serve( não encontrado`;
  const bloco = codigo.slice(i).match(/if \(req\.method === ['"]OPTIONS['"]\) \{([\s\S]*?)\n\s*\}/);
  if (!bloco) return `${edge}: bloco OPTIONS não encontrado`;
  const c = bloco[1]; const pr = c.indexOf('atenderSondaOptions('); const pc = c.indexOf('return new Response(null, { headers: corsHeaders })');
  if (pr < 0) return `${edge}: o bloco OPTIONS não chama atenderSondaOptions`;
  if (pc < 0) return `${edge}: a resposta de CORS do bloco OPTIONS mudou de forma`;
  if (pr > pc) return `${edge}: atenderSondaOptions está DEPOIS do return de CORS (código morto)`;
  if (/req\.json\(|req\.text\(|createClient\(|fetch\(/.test(c)) return `${edge}: IO dentro do bloco OPTIONS`;
  return null;
}
export function gateG3(codigo: string): string | null {
  const n = (codigo.match(/\bfetch\(/g) ?? []).length;
  if (n !== 1) return `relé: ${n} chamadas a fetch( — tem de ser exatamente 1`;
  if (!/montarRequestSonda\(/.test(codigo) || !/barreiraSaida\(/.test(codigo)) return 'relé: o fetch não passa por montarRequestSonda + barreiraSaida';
  if (/fetch\([^)]*method\s*:/.test(codigo)) return 'relé: method: literal no fetch de saída';
  if (/x-cron-secret/.test(codigo)) return 'relé: x-cron-secret aparece no relé (o segredo do cron não pode sair para a alvo)';
  return null;
}
export function gateG4(migrations: Array<{ nome: string; sql: string }>, allowlist: string[]): string | null {
  const ok = new Set(allowlist);
  for (const m of migrations) {
    if (!/deploy_sonda_alvos/.test(m.sql)) continue;
    for (const mm of m.sql.matchAll(/INSERT INTO public\.deploy_sonda_alvos[\s\S]*?VALUES([\s\S]*?);/gi)) for (const v of mm[1].matchAll(/\(\s*'([a-z0-9-]+)'/g)) if (!ok.has(v[1])) return `${m.nome}: INSERT em deploy_sonda_alvos com slug fora da allowlist: ${v[1]}`;
  }
  return null;
}
function provarEdge(edge: string, m: Manifesto, raiz: string, log: (s: string) => void): { total: number; passa: number; ruins: string[] } {
  const alvo = SONDA_CRON_ALVOS.find((a) => a.edge === edge)!; const closures = enumerarClosures(edge, raiz); const ruins: string[] = []; let passa = 0;
  m.vereditos[edge] ??= {};
  for (const c of closures) {
    const k = chaveDoManifesto(c.identidade, m.harness);
    let e = m.vereditos[edge][k];
    if (!e) {
      const v = executar(edge, c.sha, raiz);
      const cls = classificarVeredito(v, alvo.desde, alvo.desde !== null && ehAncestral(alvo.desde, c.sha, raiz));
      e = { sha: c.sha, veredito: cls, motivo: cls === 'PASSA' ? '' : (v.importErro ?? JSON.stringify({ a: v.a, b: v.b?.map((b) => [b.nome, b.efeitos, b.fetches]) }).slice(0, 300)), controle: v.c?.classe ?? 'inconclusivo', em: new Date().toISOString() };
      m.vereditos[edge][k] = e; log(`  ${edge}@${c.sha.slice(0, 9)} ${cls}${e.motivo ? ' — ' + e.motivo.slice(0, 100) : ''}`);
    }
    if (e.veredito === 'PASSA') passa++; else ruins.push(`${edge}@${e.sha.slice(0, 9)}: ${e.veredito} — ${e.motivo.slice(0, 120)}`);
  }
  return { total: closures.length, passa, ruins };
}
export function main(argv: string[], raiz = process.cwd()): number {
  const log = (s: string) => console.log(s);
  try {
    const m = lerManifesto(raiz); const harness = identidadeDoHarness(raiz);
    if (m.harness !== harness) { log(`harness mudou (${m.harness.slice(0, 12)} → ${harness.slice(0, 12)}): todos os vereditos caducam`); m.harness = harness; m.vereditos = {}; }
    if (argv.includes('--falsificar')) {
      const sint = resolve(raiz, HARNESS, 'sinteticos'); let vermelhos = 0;
      for (const nome of readdirSync(sint)) {
        const r = spawnSync('deno', ['run', '--no-remote', `--import-map=${resolve(raiz, HARNESS, 'import_map.json')}`, `--allow-read=${resolve(raiz, HARNESS)}`, resolve(raiz, HARNESS, 'runner.ts'), join(sint, nome, 'index.ts'), nome, CHAVE_TESTE, '[]'], { encoding: 'utf8', cwd: resolve(raiz, HARNESS) });
        const v: Veredito = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
        const cls = classificarVeredito(v, null, false); const esperado = ['gate-ignorado', 'ramo-morto', 'padrao'].includes(nome) ? 'PASSA' : 'FALHA';
        const ok = esperado === 'FALHA' ? cls !== 'PASSA' : cls === 'PASSA' || cls === 'INVERIFICAVEL';
        log(`  sintético ${nome}: ${cls} (esperado ${esperado}) ${ok ? '✅' : '❌'}`); if (!ok) vermelhos++;
      }
      return vermelhos === 0 ? 0 : 1;
    }
    const edges = argv.includes('--tudo') ? SONDA_CRON_ALVOS.map((a) => a.edge) : argv.includes('--backfill') ? [argv[argv.indexOf('--backfill') + 1]] : SONDA_CRON_ALVOS.map((a) => a.edge);
    let falhas = 0;
    for (const edge of edges) {
      if (!SONDA_CRON_ALVOS.some((a) => a.edge === edge)) { log(`${edge}: fora da allowlist`); return 1; }
      const g1 = gateG1(edge, readFileSync(resolve(raiz, `supabase/functions/${edge}/index.ts`), 'utf8')); if (g1) { log(`G1 ❌ ${g1}`); falhas++; }
      const r = provarEdge(edge, m, raiz, log);
      log(`${edge}: ${r.passa}/${r.total} closures PASSA${r.ruins.length ? ' ❌' : ' ✅'}`); for (const x of r.ruins) log(`   ${x}`);
      if (r.ruins.length) falhas++;
    }
    const g3 = gateG3(readFileSync(resolve(raiz, 'supabase/functions/sonda-relay/index.ts'), 'utf8')); if (g3) { log(`G3 ❌ ${g3}`); falhas++; }
    const migs = existsSync(resolve(raiz, 'supabase/migrations')) ? readdirSync(resolve(raiz, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).map((f) => ({ nome: f, sql: readFileSync(resolve(raiz, 'supabase/migrations', f), 'utf8') })) : [];
    const g4 = gateG4(migs, SONDA_CRON_ALVOS.map((a) => a.edge)); if (g4) { log(`G4 ❌ ${g4}`); falhas++; }
    gravarManifesto(m, raiz);
    if (argv.includes('--gate') && spawnSync('git', ['diff', '--quiet', '--', MANIFESTO], { cwd: raiz }).status !== 0) { log(`❌ o manifesto mudou durante o --gate: commite ${MANIFESTO} (rode --backfill --tudo localmente)`); falhas++; }
    return falhas === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof Mecanica) { console.error(`MECANICA: ${e.message}`); return 2; }
    throw e;
  }
}
if (import.meta.main) process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 4: Rodar os testes** — `bun run test -- scripts/sonda-cron-prova.test.ts` → verde. `bun run scripts:typecheck` → verde (o import de `mapa-imports.ts` e de `sonda-cron-alvos.ts` não pode usar `Deno.*` — se o `tsc` acusar `Deno`, o arquivo importado tem algo fora do puro; conserte lá).

- [ ] **Step 5: Backfill dos pilotos e do relé**

`bun scripts/sonda-cron-prova.ts --backfill --tudo` (≈ 2 min para 216 + relé). Esperado: `monthly-report: 65/65`, `calculate-scores: 79/79`, `sync-reprocess: 72/72`, `sonda-relay: 1/1`. Se `monthly-report` reportar `INVERIFICAVEL — especificador fora do catálogo: https://esm.sh/resend@2.0.0`, o `mapa-imports.ts` da Task 5 já casa `esm.sh/resend` — confira a regex; se algum controle vier `inconclusivo`, acrescente o degrau que falta em `controles` (Task 2) e re-rode. **Só commite com 100 % PASSA.**

- [ ] **Step 6: `--falsificar` e `--gate`** — `bun scripts/sonda-cron-prova.ts --falsificar` → 9 sintéticos com ✅ (6 FALHA, 3 PASSA), exit 0; `bun scripts/sonda-cron-prova.ts --gate` → exit 0 sem alterar o manifesto. Falsificação do gate: edite o manifesto trocando um `FALHA`… não há; então **adultere** um `PASSA` para `FALHA` à mão → `--gate` tem de reprovar nomeando a edge; restaure.

- [ ] **Step 7: script + CI**

`package.json`: `"sonda:cron-prova": "bun scripts/sonda-cron-prova.ts"`. `.github/workflows/ci.yml`, após o step da Task 6:
```yaml
      # Prova da allowlist da sonda por cron: cobertura do manifesto (todo closure histórico de
      # cada edge da allowlist, na identidade de harness atual) + G1 (ramo no bloco OPTIONS) +
      # G3 (relé só emite OPTIONS) + G4 (espelho no banco ⊆ allowlist). Re-executa o que mudou.
      - name: Sonda por cron — prova por execução de cada closure histórico (G1–G4)
        run: bun run sonda:cron-prova -- --gate
```

- [ ] **Step 8: Commit** — `git add scripts/sonda-cron-prova.ts scripts/sonda-cron-prova.test.ts supabase/functions/_shared/sonda-cron-prova.json package.json .github/workflows/ci.yml && git commit -m "feat(sonda-cron): prova por execução de cada closure histórico — ponto fixo, cache por (closure, harness), G1/G3/G4, backfill 100% PASSA nos pilotos"`

### Task 8: documentação, gates de docs e o PR (draft até a evidência)

**Files:**
- Create: `docs/historico/sonda-por-cron-fail-closed.md`
- Modify: `docs/historico/README.md` (linha na tabela gateada), `docs/agent/deploy.md` (§"Edge: o veredito é o ledger" ganha o ponteiro)

**Interfaces:**
- Consumes: nada de código. Produces: o registro que as próximas sessões leem antes de tocar o domínio (é o que a política do `CLAUDE.md` exige ao concluir entrega).

- [ ] **Step 1: o doc histórico**

Crie `docs/historico/sonda-por-cron-fail-closed.md` com, no mínimo: (a) o problema (o cron de sonda ativa derrubado em 2026-09-05 e por quê); (b) **por que um header num POST não resolve** — os closures sem gate (`monthly-report@ef08dddd2` manda e-mail sem autenticar; `calculate-scores@45a80118b` faz 11 escritas), com os números medidos; (c) o transporte `OPTIONS` via relé e a razão estrutural; (d) a prova por execução (216 closures dos pilotos em 71 s; 3.226 closures em 5 famílias de dependência remota); (e) **as 3 rodadas do Codex**, com o que cada uma derrubou (rodada 1: header não protege bundle sem gate; rodada 2: `historicoDesde`, redirect, controle por época, enumeração, cache, falsificações erradas; rodada 3: `PASSA`, e os P2 do replay do relé, relógio virtual, `--follow`, fallback legado); (f) o limite nomeado (dependência remota não reproduzível) e o residual de ambiente; (g) as falsificações com a mensagem de vermelho de cada uma.

- [ ] **Step 2: índice + ponteiro**

Em `docs/historico/README.md`, acrescente à tabela (o gate `docs:indice` exige resumo com ≥ `RESUMO_MIN_CHARS`):
```markdown
| [sonda-por-cron-fail-closed.md](sonda-por-cron-fail-closed.md) | a classe **"perguntar a versão sem poder disparar o efeito"**: por que um header num POST não protege bundle histórico SEM gate, o transporte OPTIONS via relé, e a prova que EXECUTA cada closure histórico contando efeito (3 rodadas de challenge) |
```
Em `docs/agent/deploy.md`, na §"Edge: o veredito é o ledger", troque a frase "**Não há cron de sonda ativa por decisão** (Codex, 2026-09-05): um rollback para bundle pré-sensor faria o cron disparar o fluxo real." por:
```markdown
**A sonda por cron existe desde 2026-09-06 e é fail-closed por CONSTRUÇÃO**: o cron não fala com a
edge — fala com a edge-relé `sonda-relay`, que emite um `OPTIONS` com credencial dedicada
(`x-sonda-credencial`, HMAC de `SONDA_HMAC_KEY`). Bundle velho responde o CORS de sempre e **não
executa nada** — provado EXECUTANDO cada closure histórico das edges da allowlist
(`bun run sonda:cron-prova`), inclusive os que não autenticavam nada. Uma edge só entra na
allowlist com 100 % dos closures `PASSA`. Detalhe: `docs/historico/sonda-por-cron-fail-closed.md`.
```

- [ ] **Step 3: gates de docs** — `bun run docs:indice && bun run docs:links && bun run docs:citacoes && bun run claude:size`; capture `exit 0` de cada.

- [ ] **Step 4: a bateria inteira, antes do PR**

```bash
bun run typecheck && bun run lint && heavy bun run test && bun run test:edges && bun run edges:typecheck \
  && bun run test:sonda-rollback && bun run sonda:cron-prova -- --gate && bun run sonda:bump \
  && bun run sonda:fingerprint && bun run sonda:nova && bun run manifesto.gate 2>/dev/null; echo "exit=$?"
```
(`manifesto.gate` só existe para `src/` — ignore se não houver script; nada desta fatia toca `src/`.)

- [ ] **Step 5: Commit + PR draft**

```bash
git add docs/historico/sonda-por-cron-fail-closed.md docs/historico/README.md docs/agent/deploy.md
git commit -m "docs(sonda-cron): registro da entrega — por que o header num POST não bastava, o OPTIONS via relé, e a prova por execução de closure"
git push -u origin HEAD
gh pr create --draft --title "feat(deploy): sonda de deploy por cron fail-closed — OPTIONS via relé com credencial dedicada, provado EXECUTANDO cada closure histórico [F1: mecanismo + prova]" --body "$(cat <<'CORPO'
Fatia F1 da spec `docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md` (v5, aprovada no challenge Codex — rodada 3: `ROLLBACK-TEST: PASSA`, `[P1] Nenhum`).

## O que entra
- `_shared/sonda-cron.ts`: credencial HMAC dedicada por edge (`SONDA_HMAC_KEY`), `atenderSondaOptions` (ramo sem IO dentro do bloco `OPTIONS`), `montarRequestSonda` (sem parâmetro de método), `barreiraSaida`, contrato completo da atestação.
- `sonda-relay`: a edge-relé — 1 `fetch`, `OPTIONS`, `redirect: "manual"`, barreira em runtime.
- Ramo `OPTIONS` em `monthly-report`, `calculate-scores`, `sync-reprocess` (+ bump).
- Prova por EXECUÇÃO: runner com relógio virtual + stubs por família; `bun run sonda:cron-prova` executa **cada closure histórico** de cada edge da allowlist e conta efeito, com controle positivo por época de autenticação; manifesto cacheado por `(closure, harness)`.
- 2 steps blocking no CI: `test:sonda-rollback` e `sonda:cron-prova --gate`.

## Por que não foi um header num POST
Existem closures históricos **sem gate nenhum** (`monthly-report@ef08dddd2` manda e-mail; `calculate-scores@45a80118b` faz 11 escritas). Header não protege quem não pede credencial. `OPTIONS` é a única requisição que todo bundle interrompe antes de qualquer IO — e isso foi **executado**, não suposto.

## Evidência
- backfill: `monthly-report` 65/65 · `calculate-scores` 79/79 · `sync-reprocess` 72/72 · `sonda-relay` 1/1 closures `PASSA`.
- falsificações (cada uma vermelha nomeando o assert): relé mandando POST · contador cego · ramo sem verificar credencial · mensagem HMAC divergente · `redirect` seguido · manifesto adulterado · sintéticos do `OPTIONS` (IO top-level, IO antes do método, helper no ramo, fallthrough, assíncrono antes do return, header qualquer).

## ⚠️ Depende do founder
1. **Provisionar `SONDA_HMAC_KEY`** nos secrets das edges: `openssl rand -base64 32`.
2. **Deploy** de `sonda-relay` (nova) + das 3 edges (bump). Sem o deploy nada quebra: alvo sem o ramo responde CORS ao relé.
3. F2 (migration do cron) vem em PR próprio.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
CORPO
)"
bash scripts/pr-watch.sh <nº> &   # arme o watcher; avise o founder no desfecho
```

- [ ] **Step 6: tirar do draft** — só depois de colar no corpo do PR as mensagens de vermelho das falsificações e os `exit 0` da bateria. `gh pr ready <nº>` (o auto-merge cuida do resto).

---

## Self-review do plano

**Cobertura da spec (v5) → tarefa:** §4.1 credencial → T1 · §4.2 ramo na alvo → T1 (helper) + T4 (as 3 edges) · §4.3 relé → T3 · §4.4 allowlist → T2, prova/enumeração/cache/G1–G4 → T5+T7 · §4.5 banco → **F2 (fora desta fatia, por desenho)** · §4.6 CLI → **F3** · §4.7 `sonda:sql` → **F3** · §5 harness/asserts/falsificações → T5+T6 · §5.1 spikes → já medidos · §6 fatias → este plano é F1 · §7 threat model → T8 (doc) + asserts em T1/T3/T5/T6 · §8 tabela por edge → F4.

**Sem placeholders:** todo passo traz o código real, o comando exato e o resultado esperado. Onde a realidade pode divergir (nome do `action` de `sync-reprocess`, especificador remoto fora do catálogo, `fetch(saida, {signal})` perdendo `redirect`), o passo diz **como medir e o que fazer**, em vez de "ajuste conforme necessário".

**Consistência de tipos:** `atenderSondaOptions(req, respostaSonda, VERSAO)` — mesma assinatura em T1, T3 e T4. `montarRequestSonda(baseUrl, alvo, credencial)` — T1, T3, runner (T5), teste (T6). `Veredito`/`Chamada` — mesma forma em T5 (produz), T6 (consome) e T7 (classifica). `SONDA_CRON_ALVOS[].controles` — T2 define, T5 resolve `$ENV`, T6 e T7 consomem. `HEADER_SONDA`/`METODO_SONDA` — uma definição (T1), citadas em T3/T5/T6/T7 e, em F2, na migration.

**Ordem e reversibilidade:** T1→T2→T3→T4→T5→T6→T7→T8. Nada nesta fatia toca produção: sem o deploy, o mecanismo é inerte; sem F2, não há cron. O único artefato gerado que entra no repo é o manifesto da prova (revisável).
