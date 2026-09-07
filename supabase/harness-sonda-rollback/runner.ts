// RUNNER — executa UM closure histórico e mede o efeito. É o instrumento do teste decisivo.
//
// Uso (sempre por subprocesso, um closure por vez):
//   deno run --no-remote --import-map=<map> --allow-read=<dirs> runner.ts <index.ts> <edge> <chave> <controles-json>
//
// Imprime UMA linha JSON com o veredito bruto. Quem classifica é quem chama (o teste sempre-on ou
// `scripts/sonda-cron-prova.ts`) — o runner não decide, ele MEDE.
//
// O protocolo tem três partes, e nenhuma sozinha prova o que interessa:
//   (a) o OPTIONS do relé            → tem de ser inerte (o que o cron faria contra este bundle);
//   (b) 4 negativos da credencial    → inertes E com resposta idêntica ao preflight do browser;
//   (c) a escada de controles        → alguma tem de fazer o contador SUBIR, senão o zero de (a)
//                                      é cegueira e o closure vira INVERIFICAVEL.
import { contador, zerar } from "./stubs/contador.ts";
import { derivarCredencial, montarRequestSonda } from "../functions/_shared/sonda-cron.ts";

const [entrada, edge, chave, controlesJson] = Deno.args;

type Controle = { metodo: "POST"; headers: Record<string, string>; corpo: string | null; nota: string };
const controles: Controle[] = JSON.parse(controlesJson ?? "[]");

const ENV: Record<string, string> = {
  CRON_SECRET: "cron-secret-de-teste",
  SONDA_HMAC_KEY: chave,
  SUPABASE_URL: "http://projeto.local",
  SUPABASE_SERVICE_ROLE_KEY: "srk-de-teste",
  SUPABASE_ANON_KEY: "anon-de-teste",
  OMIE_WEBHOOK_SECRET: "webhook-de-teste",
  RESEND_API_KEY: "re-de-teste",
};

const g = globalThis as unknown as Record<string, unknown>;

// ── Relógio virtual ───────────────────────────────────────────────────────────────────────────
// Efeito agendado antes do `return` (um `setTimeout(() => supabase.from(...).insert(), 50)`, um
// `EdgeRuntime.waitUntil(promessa)`) acontece DEPOIS que a resposta sai. Ler o contador na hora do
// return diria zero e estaria mentindo. Aqui todo agendamento entra numa fila e é drenado até a
// quiescência antes da leitura — com teto, porque fila que não esvazia é `FALHA`, não "quiesceu".
const timersOriginais = { setTimeout: g.setTimeout as typeof setTimeout };
const fila: Array<() => unknown> = [];
let tarefasExecutadas = 0;
const TETO_TAREFAS = 10_000;
g.setTimeout = ((fn: () => unknown) => { fila.push(fn); return fila.length; }) as unknown as typeof setTimeout;
g.setInterval = ((fn: () => unknown) => { fila.push(fn); return fila.length; }) as unknown as typeof setInterval;
g.clearTimeout = () => {};
g.clearInterval = () => {};
g.EdgeRuntime = { waitUntil: (p: unknown) => { fila.push(() => p); } };

async function drenar(): Promise<boolean> {
  while (fila.length > 0) {
    if (++tarefasExecutadas > TETO_TAREFAS) return false;
    const tarefa = fila.shift()!;
    try {
      await tarefa();
    } catch {
      // Exceção na tarefa não é evidência de inocência: o que ela tiver chamado já foi contado.
    }
    await Promise.resolve();
  }
  return true;
}

// ── Patches, ANTES do import ──────────────────────────────────────────────────────────────────
(Deno as unknown as { serve: (a: unknown, b?: unknown) => unknown }).serve = (a, b) => {
  g.__handler = typeof a === "function" ? a : b;
  return {};
};
(Deno.env as unknown as { get: (k: string) => string | undefined }).get = (k) => ENV[k] ?? `stub-${k}`;
g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = new Request(input, init);
  contador.fetches++;
  contador.fetchUrls.push(`${r.method} ${r.url}`);
  throw new Error("fetch bloqueado pelo harness");
}) as typeof fetch;

let importErro: string | null = null;
try {
  await import(`file://${entrada}`);
} catch (e) {
  importErro = String((e as Error)?.message ?? e).slice(0, 200);
}
// Efeito no TOPO do módulo acontece durante o import. Contador que sobe aqui é FALHA — e é por isso
// que ele é lido ANTES de zerar para as chamadas.
const efeitosNoImport = contador.efeitos + contador.fetches;

const handler = g.__handler as ((r: Request) => Promise<Response>) | undefined;
const url = `${ENV.SUPABASE_URL}/functions/v1/${edge}`;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function chamar(req: Request) {
  zerar();
  let status = -1;
  let corpo = "";
  let headers: Record<string, string> = {};
  try {
    const r = await handler!(req);
    status = r.status;
    corpo = await r.text();
    headers = Object.fromEntries([...r.headers.entries()].sort());
  } catch (e) {
    corpo = `__erro__:${String((e as Error)?.message ?? e).slice(0, 80)}`;
  }
  const quiesceu = await drenar();
  return {
    status,
    probe: /"probe"\s*:\s*true/.test(corpo),
    efeitos: contador.efeitos,
    fetches: contador.fetches,
    corpoHash: await sha256(corpo),
    headers,
    quiesceu,
  };
}

/** `$NOME` nos headers do controle vira o valor da env de teste — nenhum segredo real no repo. */
function resolver(v: string): string {
  return v.replace(/\$([A-Z_]+)/g, (_, n) => ENV[n] ?? `stub-${n}`);
}

const out: Record<string, unknown> = { entrada, edge, importErro, efeitosNoImport, handler: !!handler };

if (handler) {
  const cred = await derivarCredencial(chave, edge);
  out.a = await chamar(montarRequestSonda(ENV.SUPABASE_URL, edge, cred));

  const negativos: Array<[string, Record<string, string>]> = [
    ["preflight-browser", {
      Origin: "https://app.exemplo",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "x-sonda-credencial",
    }],
    ["hex-invalido", { "x-sonda-credencial": `zz${cred.slice(2)}` }],
    ["credencial-errada", { "x-sonda-credencial": await derivarCredencial(`${chave}x`, edge) }],
    ["outra-edge", { "x-sonda-credencial": await derivarCredencial(chave, `${edge}-outra`) }],
  ];
  const b: unknown[] = [];
  for (const [nome, headers] of negativos) {
    b.push({ nome, ...(await chamar(new Request(url, { method: "OPTIONS", headers }))) });
  }
  out.b = b;

  const escada: Array<[string, Controle]> = [
    ["sem-credencial", { metodo: "POST", headers: { "content-type": "application/json" }, corpo: "{}", nota: "" }],
    ...controles.map((c, i): [string, Controle] => [`controle-${i}`, c]),
  ];
  let c: Record<string, unknown> = { classe: "inconclusivo", efeitos: 0, fetches: 0, degrau: null };
  const tentativas: unknown[] = [];
  for (const [nome, ctl] of escada) {
    const headers = Object.fromEntries(Object.entries(ctl.headers).map(([k, v]) => [k, resolver(v)]));
    const r = await chamar(new Request(url, { method: ctl.metodo, headers, body: ctl.corpo }));
    tentativas.push({ nome, status: r.status, efeitos: r.efeitos, fetches: r.fetches });
    if (r.efeitos + r.fetches > 0) {
      c = {
        classe: nome === "sem-credencial" ? "sem-gate" : "controle",
        efeitos: r.efeitos,
        fetches: r.fetches,
        degrau: nome,
      };
      break;
    }
  }
  out.c = c;
  out.tentativasControle = tentativas;
  out.chamadas = contador.chamadas.slice(0, 12);
  out.fetchUrls = contador.fetchUrls.slice(0, 6);
}

// `console.log` com UMA linha: quem chama lê a última linha que começa com `{`. Bundles antigos
// escrevem no stdout à vontade (a `calculate-scores` de 2026-03 loga a cada etapa).
console.log(JSON.stringify(out));
// O relógio virtual sequestrou `setTimeout`; devolve para não deixar o processo pendurado.
g.setTimeout = timersOriginais.setTimeout;
