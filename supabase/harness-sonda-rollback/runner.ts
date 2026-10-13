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

// ── Timers REAIS no controle positivo (c) ──────────────────────────────────────────────────────
// (a)/(b) seguem com a fila acima, drenada depois do `return` — exatamente como sempre. O controle
// (c) usa timers NATIVOS: uma edge que espera um timer DENTRO do handler (a trégua de 1,5 s entre
// contas da `picking-fila-omie`) pendurava o runner com a fila, porque a tarefa só rodaria depois
// da resposta. Relógio virtual no controle foi tentado e descartado (challenge Codex, 6 rodadas,
// 2026-10-13): ele não sabe quanto dura uma operação nativa (`crypto.subtle`, I/O), então qualquer
// salto de tempo reordena timers contra elas e pode fazer o controle registrar uma chamada que a
// execução real não faz. Com timers nativos, ordem e duração são as da produção por construção.
// O wrapper é instalado ANTES do import, então referência capturada (`const st = setTimeout`)
// também obedece à chave `timersReais`.
const timeoutReal = timersOriginais.setTimeout;
const clearTimeoutReal = g.clearTimeout as typeof clearTimeout;
const intervalReal = g.setInterval as typeof setInterval;
const clearIntervalReal = g.clearInterval as typeof clearInterval;
let timersReais = false;
const timeoutsReais = new Set<number>();
const intervalosReais = new Set<number>();
// (a)/(b): `fila.push(fn)` exatamente como antes — inclusive SEM repassar os argumentos extras do
// `setTimeout(fn, ms, ...args)`. Repassá-los mudaria o veredito de bundle antigo (challenge Codex,
// 7ª rodada): um `setTimeout(url => fetch(url), 0, "…")` recebia `undefined` e lançava antes de
// contar. Fidelidade ao comportamento anterior vale mais que "corrigir" o stub aqui.
g.setTimeout = ((fn: (...a: unknown[]) => unknown, ms?: unknown, ...args: unknown[]) => {
  if (!timersReais) {
    fila.push(fn as () => unknown);
    return fila.length;
  }
  const id = timeoutReal(() => {
    timeoutsReais.delete(id);
    fn(...args);
  }, Number(ms) || 0) as unknown as number;
  timeoutsReais.add(id);
  return id;
}) as unknown as typeof setTimeout;
// No controle, intervalo NATIVO de verdade (dispara repetidas vezes): convertê-lo em disparo único
// mudaria o fluxo de um watchdog periódico e poderia registrar uma chamada que a execução real não
// faz (7ª rodada). Ele é cancelado no fim do controle, sem que o runner espere por ele.
g.setInterval = ((fn: (...a: unknown[]) => unknown, ms?: unknown, ...args: unknown[]) => {
  if (!timersReais) {
    fila.push(fn as () => unknown);
    return fila.length;
  }
  const id = intervalReal(() => fn(...args), Number(ms) || 0) as unknown as number;
  intervalosReais.add(id);
  return id;
}) as unknown as typeof setInterval;
// Como no nativo, os dois cancelamentos são intercambiáveis: `clearTimeout` cancela intervalo e
// vice-versa (HTML Living Standard, timers). Exigir o par certo deixaria um intervalo "cancelado"
// por `clearTimeout` disparando no controle (challenge Codex, 8ª rodada).
const cancelarReal = (id?: number) => {
  if (id === undefined) return;
  if (timeoutsReais.delete(id)) clearTimeoutReal(id);
  if (intervalosReais.delete(id)) clearIntervalReal(id);
};
g.clearTimeout = cancelarReal as unknown as typeof clearTimeout;
g.clearInterval = cancelarReal as unknown as typeof clearInterval;
// `waitUntil`: em (a)/(b) a promessa entra na fila, como sempre. No controle ela é acompanhada com os
// timers AINDA nativos (challenge Codex, 9ª rodada): um watchdog criado e cancelado dentro da tarefa
// de fundo não pode cair na fila virtual depois que o controle desliga os timers reais.
const fundoReais = new Set<Promise<unknown>>();
g.EdgeRuntime = {
  waitUntil: (p: unknown) => {
    if (!timersReais) {
      fila.push(() => p);
      return;
    }
    const acompanhada = Promise.resolve(p).catch(() => {});
    fundoReais.add(acompanhada);
    acompanhada.finally(() => fundoReais.delete(acompanhada));
  },
};

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

/** Teto, em ms reais, para timers do controle que ainda não dispararam depois da resposta. */
const TETO_TIMERS_POS_RESPOSTA_MS = 10_000;

async function chamar(req: Request, reais = false) {
  zerar();
  let status = -1;
  let corpo = "";
  let headers: Record<string, string> = {};
  timersReais = reais;
  try {
    const r = await handler!(req);
    status = r.status;
    corpo = await r.text();
    headers = Object.fromEntries([...r.headers.entries()].sort());
  } catch (e) {
    corpo = `__erro__:${String((e as Error)?.message ?? e).slice(0, 80)}`;
  }
  if (reais) {
    // Efeito agendado para DEPOIS da resposta também conta no controle: espera os timeouts reais
    // pendentes (com teto). O que sobrar — e todo intervalo, que não termina sozinho — é cancelado
    // para não atravessar o próximo degrau.
    const limite = performance.now() + TETO_TIMERS_POS_RESPOSTA_MS;
    while ((timeoutsReais.size > 0 || fundoReais.size > 0) && performance.now() < limite) {
      await new Promise<void>((r) => timeoutReal(r, 10));
    }
    for (const id of timeoutsReais) clearTimeoutReal(id);
    timeoutsReais.clear();
    for (const id of intervalosReais) clearIntervalReal(id);
    intervalosReais.clear();
    fundoReais.clear();
    timersReais = false;
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
    const r = await chamar(new Request(url, { method: ctl.metodo, headers, body: ctl.corpo }), true);
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
