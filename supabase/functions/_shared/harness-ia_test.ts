// harness-ia_test.ts — helper SÓ PARA `*_test.ts` (sem `Deno.test` próprio; o sufixo `_test` deixa o
// arquivo fora da superfície das edges, como o `harness-handler_test.ts`). Carrega o `index.ts` de uma
// edge de IA com o SDK da Anthropic trocado por um FALSO que captura os parâmetros de cada
// `messages.create` — a prova do que de fato iria para o modelo (`system`, `messages`).
//
// Por que existe (scanner Lovable Security, lote 7 — 2026-11-18): as edges de IA importam o SDK por
// `npm:@anthropic-ai/sdk`, que não está no `node_modules` e não carrega na suíte offline
// (`deno test --no-remote`). Por isso o lote 6 provou a ligação do `copilot-analyze` só por AST
// (`src/__tests__/edge-seg-lote6-gate.test.ts`). Aqui o handler REAL roda: o texto do `index.ts` é
// lido, e só dois especificadores mudam — o do SDK e o do `_shared/anthropic-cliente.ts` (o único
// outro lugar que importa o SDK) apontam para o módulo falso; os relativos viram `file://` absolutos,
// porque o módulo reescrito é carregado como `data:` e não teria pasta para resolvê-los. Todo o resto
// (gate, cota, validação, montagem do prompt, normalização da saída) é o código da edge.
//
// Fronteira: um import que NÃO case a regex abaixo (ex.: `import x from 'y'` com aspas simples) fica
// como está; se for relativo, o `import()` falha e o teste fica vermelho — não verde por engano.
// O que fica fora: o SDK de verdade (serialização, retry, coleira de relógio) e o modelo.
//
// Uso:
//   const h = instalarHarness({ ...ENV_TESTE, ...ENV_IA });
//   const ia = instalarAnthropicFalsa();
//   await importarEdgeComAnthropicFalsa(new URL("./index.ts", import.meta.url));
//   const handler = h.handler();

/** Env extra que as edges de IA leem (falso; nada aqui é segredo). */
export const ENV_IA: Record<string, string> = {
  SUPABASE_ANON_KEY: "anon-de-teste",
  ANTHROPIC_API_KEY: "anthropic-de-teste",
};

/** Os parâmetros de um `messages.create`, como a edge os montou. */
export type ParamsAnthropic = Record<string, unknown> & {
  system?: unknown;
  messages?: Array<{ role: string; content: unknown }>;
};

export interface AnthropicFalsa {
  /** Toda chamada a `messages.create` desde o último `limpar()`. */
  chamadas: ParamsAnthropic[];
  limpar(): void;
  /** Troca a resposta do modelo (default: `tool_use` com `{}`, na tool forçada pelo `tool_choice`). */
  responder(fn: (p: ParamsAnthropic) => unknown): void;
}

const CHAVE_GLOBAL = "__anthropicFalsaLote7";

const MODULO_FALSO = `
const alvo = () => globalThis[${JSON.stringify(CHAVE_GLOBAL)}];
export default class Anthropic {
  constructor(_opcoes) {}
  messages = { create: async (p) => alvo()(p) };
}
export function criarClienteAnthropic(_apiKey, _ajuste) { return new Anthropic({}); }
`;

const URL_FALSA = `data:application/javascript,${encodeURIComponent(MODULO_FALSO)}`;

/** Instala o alvo global que o módulo falso chama. Rode ANTES de importar a edge. */
export function instalarAnthropicFalsa(): AnthropicFalsa {
  const chamadas: ParamsAnthropic[] = [];
  let resposta: (p: ParamsAnthropic) => unknown = (p) => {
    const escolha = p.tool_choice as { name?: string } | undefined;
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: escolha?.name ?? "tool", input: {} }],
      usage: {},
    };
  };
  (globalThis as Record<string, unknown>)[CHAVE_GLOBAL] = (p: ParamsAnthropic) => {
    // Cópia profunda: o que vale é o que a edge entregou NAQUELE instante.
    chamadas.push(JSON.parse(JSON.stringify(p)));
    return resposta(p);
  };
  return {
    chamadas,
    limpar: () => {
      chamadas.length = 0;
    },
    responder: (fn) => {
      resposta = fn;
    },
  };
}

const RE_ESPECIFICADOR = /(\bfrom\s+|\bimport\s*\(\s*|^import\s+)"([^"]+)"/gm;

/** Reescreve os especificadores do texto de um módulo (exportado para o teste do próprio harness). */
export function reescreverImports(fonte: string, base: URL): { texto: string; trocados: number } {
  let trocados = 0;
  const texto = fonte.replace(RE_ESPECIFICADOR, (inteiro, antes: string, spec: string) => {
    if (spec.startsWith("npm:@anthropic-ai/sdk") || spec.endsWith("/_shared/anthropic-cliente.ts")) {
      trocados++;
      return `${antes}"${URL_FALSA}"`;
    }
    if (spec.startsWith("./") || spec.startsWith("../")) return `${antes}"${new URL(spec, base).href}"`;
    return inteiro;
  });
  return { texto, trocados };
}

/** Importa o `index.ts` com o SDK falso. Lança se o arquivo não importa o SDK por nenhuma das duas vias. */
export async function importarEdgeComAnthropicFalsa(indexUrl: URL): Promise<void> {
  const fonte = await Deno.readTextFile(indexUrl);
  const { texto, trocados } = reescreverImports(fonte, indexUrl);
  if (trocados === 0) {
    throw new Error(`${indexUrl.pathname}: nenhum import do SDK da Anthropic trocado — o harness não sabe o que falsificar`);
  }
  await import(`data:application/typescript,${encodeURIComponent(texto)}`);
}

/** PNG 1×1 válido (os magic bytes decidem o media type em `_shared/imagem.ts`). */
export const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Todo o texto que viaja no `system` (string ou blocos `{type:"text", text}`). */
export function textoDoSystem(p: ParamsAnthropic): string {
  const s = p.system;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b) => (b && typeof b === "object" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n");
  return "";
}

/** Todo o texto das mensagens (string ou blocos de texto; imagem fica de fora). */
export function textoDasMensagens(p: ParamsAnthropic): string {
  return (p.messages ?? []).map((m) => {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
        .join("\n");
    }
    return "";
  }).join("\n");
}
