// Testemunhas do setup no ambiente `node` (project `node` do vitest.config.ts) — e do contrato
// storage-do-client, que é o que motiva o `setup.ts` existir fora do jsdom.
//
// A partição é por EXTENSÃO: `.ts` ⇒ project `node` ⇒ `setupFiles: [setup.ts]`, sem `setup-dom`.
// O irmão `.tsx` (`src/test/setup-ambiente-dom.test.tsx`) prova o outro lado. NÃO declaramos
// `@vitest-`+`environment node` aqui: com a partição por extensão isso seria redundante, e a
// diretiva é uma superfície que o vitest lê por regex no TEXTO INTEIRO do arquivo — citá-la, até
// em prosa, troca o ambiente em silêncio (docs/historico/docblock-de-ambiente-que-liga-o-que-
// nega.md). Menos superfície, e o `expect(typeof document)` abaixo cobre o mesmo eixo ASSERINDO
// o ambiente em vez de declará-lo.
import { describe, it, expect } from "vitest";
import { installStorageShim } from "./setup";
import { supabase } from "@/integrations/supabase/client";

describe("setup no ambiente node", () => {
  it("é MESMO o node, e o ramo de DOM não vazou para cá", () => {
    // O rótulo da saída do vitest é o nome do PROJECT, não o ambiente que rodou. Esta é a
    // asserção que denuncia uma troca — e também a que fica vermelha se `setup-dom.ts` for
    // parar no `setupFiles` do project `node` (ele estoura em `window`).
    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");
  });

  it("instala um storage funcional onde o Node não tem", () => {
    localStorage.setItem("chave", "valor");
    expect(localStorage.getItem("chave")).toBe("valor");
    expect(localStorage.length).toBe(1);
    localStorage.clear();
    expect(localStorage.getItem("chave")).toBeNull();
  });

  it("polifila MediaStream", () => {
    expect(typeof globalThis.MediaStream).toBe("function");
  });

  it("deixa um teste simular ausência de storage DEPOIS do setup", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
    expect(globalThis.localStorage).toBeUndefined();
    Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    expect(globalThis.localStorage.setItem).toBeTypeOf("function");
  });
});

// ── installStorageShim: os dois ramos, pela FUNÇÃO ──────────────────────────────────────────────
// A sonda do shim é `setItem`/`removeItem`, não `typeof` — de propósito: o Node 22+ declara um
// `localStorage` global que EXISTE e não funciona sem `--localstorage-file`, e ele sombreia o do
// jsdom. Um guard por `typeof` deixaria esse passar. Os dois ramos não são observáveis pelo efeito
// colateral do setup (nesta máquina o shim entra nos DOIS ambientes), então a asserção é sobre a
// função — que é por isso que `setup.ts` a exporta.
describe("installStorageShim", () => {
  const trocar = (valor: unknown) =>
    Object.defineProperty(globalThis, "localStorage", { value: valor, configurable: true, writable: true });

  it("NÃO troca um storage que já funciona", () => {
    const store = new Map<string, string>();
    const funcional = {
      get length() { return store.size; },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => { store.delete(k); },
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
    } as Storage;
    const original = globalThis.localStorage;
    trocar(funcional);
    try {
      installStorageShim("localStorage");
      expect(globalThis.localStorage).toBe(funcional); // identidade PRESERVADA
    } finally {
      trocar(original);
    }
  });

  it("substitui um storage presente-porém-QUEBRADO", () => {
    // O caso que o `typeof` não pegaria: existe, mas lança ao usar.
    const quebrado = { setItem() { throw new TypeError("quebrado"); } } as unknown as Storage;
    const original = globalThis.localStorage;
    trocar(quebrado);
    try {
      installStorageShim("localStorage");
      expect(globalThis.localStorage).not.toBe(quebrado); // identidade TROCADA
      globalThis.localStorage.setItem("x", "1");
      expect(globalThis.localStorage.getItem("x")).toBe("1");
    } finally {
      trocar(original);
    }
  });
});

// ── contrato storage-do-client ──────────────────────────────────────────────────────────────────
// `src/integrations/supabase/client.ts` passa `localStorage` como storage do auth, e 474 módulos
// importam esse client. Se o storage NÃO chegar, o supabase-js não quebra: ele cai calado no
// `memoryLocalStorageAdapter` dele (node_modules/@supabase/auth-js/src/GoTrueClient.ts:369-386 —
// `if (settings.storage)` … `else` … memória). Nada explode; a sessão só deixa de sobreviver.
// Estas duas testemunhas existem para esse flip ser IMPOSSÍVEL de passar despercebido.
//
// A marca ASCII "contrato storage-do-client" no nome dos dois testes é o que
// `scripts/test-setup-contrato.sh --falsificar` casa para exigir vermelho ESPECÍFICO.
describe("contrato storage-do-client", () => {
  // Chave derivada como o supabase-js deriva
  // (node_modules/@supabase/supabase-js/src/SupabaseClient.ts:127):
  //   `sb-${baseUrl.hostname.split('.')[0]}-auth-token`
  // Derivar (em vez de fixar a string) mantém a testemunha honesta se a URL do projeto mudar; e
  // se o supabase-js mudar a DERIVAÇÃO, este teste fica VERMELHO — nunca verde por engano, que é
  // a direção segura de falhar.
  const chaveDeSessao = () =>
    `sb-${new URL(import.meta.env.VITE_SUPABASE_URL as string).hostname.split(".")[0]}-auth-token`;

  it("contrato storage-do-client: getSession devolve a sessão que ESTE teste gravou no localStorage", async () => {
    // Prova por API PÚBLICA. Pré-populamos o localStorage do processo e pedimos a sessão ao
    // client REAL. Ele só a encontra se o storage que recebemos no construtor for ESTE. Sob o
    // flip para memória, `getSession()` devolve `session: null` — vermelho.
    //
    // Sem rede: `__loadSession` (GoTrueClient.ts:1607+) lê do storage, valida a forma
    // (`access_token` + `refresh_token` + `expires_at`) e só chama `_callRefreshToken` se a
    // sessão estiver EXPIRADA. Por isso o `expires_at` a um dia daqui: nenhum refresh, nenhum
    // fetch.
    const chave = chaveDeSessao();
    const expiraEm = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
    const sessaoSintetica = {
      access_token: "token-sintetico-do-teste",
      refresh_token: "refresh-sintetico-do-teste",
      expires_at: expiraEm,
      token_type: "bearer",
      user: { id: "usuario-sintetico-do-teste" },
    };
    localStorage.setItem(chave, JSON.stringify(sessaoSintetica));
    try {
      const { data, error } = await supabase.auth.getSession();
      expect(error).toBeNull();
      expect(data.session).not.toBeNull();
      expect(data.session?.access_token).toBe("token-sintetico-do-teste");
      expect(data.session?.user?.id).toBe("usuario-sintetico-do-teste");
    } finally {
      localStorage.removeItem(chave);
    }
  });

  it("contrato storage-do-client: o storage do auth É o globalThis.localStorage", () => {
    // Reforço por IDENTIDADE. `storage` é `protected` no GoTrueClient (GoTrueClient.ts:242) e o
    // alcance aqui é DE PROPÓSITO: é a única forma de provar "é ESTE objeto", e não "algum
    // storage qualquer", sem rede e sem depender do comportamento observável. Se o supabase-js
    // RENOMEAR o campo, esta asserção deve ser CORRIGIDA para o nome novo — nunca removida:
    // removê-la devolve ao flip silencioso o eixo que ela cobre.
    expect((supabase.auth as unknown as { storage: Storage }).storage).toBe(globalThis.localStorage);
  });
});
