// harness-handler.ts — SÓ PARA `*_test.ts`. Carrega o `index.ts` de uma edge como MÓDULO e
// captura o handler que ela entrega ao `Deno.serve`, com `Deno.env.get` e `fetch` substituídos
// ANTES da importação (os `index.ts` leem env no topo do módulo e o gate de auth chama `fetch`).
//
// Nasceu no lote H do plano de melhoria v2 (2026-10-18): 13 edges carregavam uma CÓPIA local de
// `authorizeCronOrStaff` que devolvia boolean; trocar pela canônica (`_shared/auth.ts`, que devolve
// `AuthResult`) sem trocar o teste `if (!(await authorizeCronOrStaff(req)))` deixa `{ok:false}`
// truthy e ABRE a edge. O teste negativo de HANDLER (sem credencial → 401 e ZERO `fetch`) é o que
// pega essa classe — teste do helper isolado não vê o `if` do handler.
//
// Convenção de uso (import COMPUTADO: o `deno test` type-checaria o `index.ts` contra o supabase-js do
// `node_modules`, outra versão da do lock do `edges:typecheck` — TS2322 falsos; o type-check é dele):
//
//   const h = instalarHarness();
//   await import(new URL("./index.ts", import.meta.url).href);  // computado: ver index_test.ts
//   const handler = h.handler();
//
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/<edge>/
// (o `npm:@supabase/supabase-js` resolve pelo `node_modules` do `bun install`, offline).

export type Handler = (req: Request) => Promise<Response> | Response;

/** Credenciais FALSAS que o `fetch` substituto reconhece. Nada aqui é segredo real. */
export const ENV_TESTE: Record<string, string> = {
  CRON_SECRET: "cron-de-teste",
  SUPABASE_URL: "https://ref-de-teste.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-de-teste",
};

/** JWTs falsos → usuário e papéis que o `/auth/v1/user` + `/rest/v1/user_roles` simulados devolvem. */
export const USUARIOS_TESTE: Record<string, { id: string; roles: string[] }> = {
  "jwt-employee": { id: "u-employee", roles: ["employee"] },
  "jwt-master": { id: "u-master", roles: ["master"] },
  "jwt-customer": { id: "u-customer", roles: ["customer"] },
  "jwt-sem-papel": { id: "u-sem-papel", roles: [] },
};

export interface Harness {
  /** O handler capturado do `Deno.serve`. Lança se o módulo não chamou `Deno.serve`. */
  handler(): Handler;
  /** TODO request que saiu pelo `fetch` desde o último `limpar()` — inclusive os de auth. */
  chamadas: Request[];
  /** Só os requests que NÃO são o gate de auth (user/user_roles): o que seria EFEITO real. */
  chamadasForaDoGate(): Request[];
  limpar(): void;
  /** Substitui a resposta padrão para URLs fora do gate (default: 500 `{}`). */
  responderForaDoGate(fn: (r: Request) => Promise<Response> | Response): void;
}

function ehGateAuth(url: URL): boolean {
  return url.pathname === "/auth/v1/user" || url.pathname === "/rest/v1/user_roles";
}

/** `fetch` falso: simula só o Supabase Auth + a leitura de `user_roles`. Qualquer outra URL é efeito. */
async function responderGate(r: Request): Promise<Response | null> {
  const url = new URL(r.url);
  if (!url.href.startsWith(ENV_TESTE.SUPABASE_URL) || !ehGateAuth(url)) return null;
  if (url.pathname === "/auth/v1/user") {
    const token = (r.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const u = USUARIOS_TESTE[token];
    if (!u) return new Response(JSON.stringify({ msg: "invalid JWT" }), { status: 401 });
    return new Response(JSON.stringify({ id: u.id }), { status: 200 });
  }
  const m = /user_id=eq\.([^&]+)/.exec(url.search);
  const u = Object.values(USUARIOS_TESTE).find((x) => x.id === m?.[1]);
  return new Response(JSON.stringify((u?.roles ?? []).map((role) => ({ role }))), { status: 200 });
}

export function instalarHarness(env: Record<string, string> = ENV_TESTE): Harness {
  let capturado: Handler | null = null;
  const chamadas: Request[] = [];
  let foraDoGate: (r: Request) => Promise<Response> | Response = () =>
    new Response("{}", { status: 500, headers: { "content-type": "application/json" } });

  (Deno as unknown as { serve: (a: unknown, b?: unknown) => unknown }).serve = (a, b) => {
    capturado = (typeof a === "function" ? a : b) as Handler;
    return {};
  };
  (Deno.env as unknown as { get: (k: string) => string | undefined }).get = (k) => env[k];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    chamadas.push(r);
    return (await responderGate(r)) ?? (await foraDoGate(r));
  }) as typeof fetch;

  return {
    handler: () => {
      if (!capturado) throw new Error("o módulo não chamou Deno.serve — nada para testar");
      return capturado;
    },
    chamadas,
    chamadasForaDoGate: () => chamadas.filter((r) => !ehGateAuth(new URL(r.url))),
    limpar: () => {
      chamadas.length = 0;
    },
    responderForaDoGate: (fn) => {
      foraDoGate = fn;
    },
  };
}

/** Falha com mensagem legível; `JSON.stringify` para comparar estrutura. */
export function igual(recebido: unknown, esperado: unknown, msg: string): void {
  if (JSON.stringify(recebido) !== JSON.stringify(esperado)) {
    throw new Error(
      `${msg}\n  esperado: ${JSON.stringify(esperado)}\n  recebido: ${JSON.stringify(recebido)}`,
    );
  }
}

/**
 * Os 4 casos negativos + 1 controle positivo que TODA edge com `authorizeCronOrStaff` + sonda tem
 * de passar. `url` é a URL pública da edge (só para montar o Request); `versaoEsperada` é o
 * `VERSAO` do `versao.ts` dela — o controle positivo prova que o request ALCANÇOU o handler e que a
 * sonda (único caminho sem efeito) respondeu, senão um 401 vindo de qualquer lugar passaria.
 */
export function registrarCasosDeGate(
  nome: string,
  h: Harness,
  versaoEsperada: string,
): void {
  const url = `${ENV_TESTE.SUPABASE_URL}/functions/v1/${nome}`;
  const post = (headers: Record<string, string>, corpo: unknown = {}) =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(corpo),
    });

  Deno.test(`${nome}: sem credencial → 401 e ZERO fetch`, async () => {
    h.limpar();
    const r = await h.handler()(post({}));
    igual(r.status, 401, "status");
    await r.body?.cancel();
    igual(h.chamadas.map((c) => c.url), [], "nenhum request pode sair sem credencial");
  });

  Deno.test(`${nome}: x-cron-secret ERRADO → 401 e ZERO fetch`, async () => {
    h.limpar();
    const r = await h.handler()(post({ "x-cron-secret": "nao-e-o-segredo" }));
    igual(r.status, 401, "status");
    await r.body?.cancel();
    igual(h.chamadas.map((c) => c.url), [], "cron-secret errado não pode abrir nada");
  });

  Deno.test(`${nome}: Bearer inválido → 401 e só o /auth/v1/user saiu`, async () => {
    h.limpar();
    const r = await h.handler()(post({ Authorization: "Bearer jwt-invalido" }));
    igual(r.status, 401, "status");
    await r.body?.cancel();
    igual(
      h.chamadas.map((c) => new URL(c.url).pathname),
      ["/auth/v1/user"],
      "JWT inválido: só a validação do token pode sair",
    );
  });

  Deno.test(`${nome}: JWT de CUSTOMER (role errada) → 401 e ZERO efeito fora do gate`, async () => {
    h.limpar();
    const r = await h.handler()(post({ Authorization: "Bearer jwt-customer" }));
    igual(r.status, 401, "status");
    await r.body?.cancel();
    igual(
      h.chamadas.map((c) => new URL(c.url).pathname),
      ["/auth/v1/user", "/rest/v1/user_roles"],
      "customer: só user + user_roles podem sair; nada de dado/Omie",
    );
    igual(h.chamadasForaDoGate().length, 0, "zero efeito fora do gate");
  });

  Deno.test(`${nome}: CONTROLE — x-cron-secret válido + {probe:true} → 200 com VERSAO e ZERO fetch`, async () => {
    h.limpar();
    const r = await h.handler()(post({ "x-cron-secret": ENV_TESTE.CRON_SECRET }, { probe: true }));
    igual(r.status, 200, "status");
    const corpo = await r.json();
    igual(corpo.probe, true, "eco probe:true");
    igual(corpo.versao, versaoEsperada, "VERSAO da sonda");
    igual(h.chamadas.length, 0, "a sonda é o único caminho sem efeito: zero fetch");
  });
}
