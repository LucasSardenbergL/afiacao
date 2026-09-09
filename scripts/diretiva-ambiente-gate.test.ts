import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditarDiretivas,
  globsDosProjects,
  LINHAS_CABECALHO,
  AMBIENTES_PERMITIDOS,
} from "./diretiva-ambiente-gate";

// NUNCA escrever o literal completo aqui: o vitest o leria neste próprio arquivo
// (regex no texto inteiro, coverage.DfSpMS-b.js:2403) e trocaria o ambiente do teste.
const DIR = "@vitest-" + "environment";

// `import.meta.dir` é API do Bun: sob o vitest ela é `undefined` (mesma pegadinha documentada em
// scripts/psql-ro-error-stop-gate.ts:20). `import.meta.dirname` é padrão Node/vitest e já é o que
// os outros gates deste diretório usam (hooks-guard-cobertura.test.ts, authz-gate-check.test.ts).
const fixture = (nome: string) => ({
  caminho: `fixture/${nome}`,
  texto: readFileSync(join(import.meta.dirname, "__fixtures__/diretiva-ambiente", nome), "utf8"),
});

describe("gate de diretiva de ambiente", () => {
  it("aceita arquivo sem diretiva", () => {
    expect(auditarDiretivas([fixture("ok-sem.txt")])).toEqual([]);
  });

  it("aceita uma diretiva node no cabeçalho", () => {
    expect(auditarDiretivas([fixture("ok-node.txt")])).toEqual([]);
  });

  it("rejeita duas ocorrências", () => {
    const achados = auditarDiretivas([fixture("dupla.txt")]);
    expect(achados).toHaveLength(1);
    expect(achados[0].msg).toContain("2 ocorrências");
  });

  it("rejeita ocorrência fora do cabeçalho", () => {
    const achados = auditarDiretivas([fixture("meio.txt")]);
    expect(achados).toHaveLength(1);
    expect(achados[0].msg).toContain(`primeiras ${LINHAS_CABECALHO} linhas`);
    expect(achados[0].linha).toBe(6);
  });

  it("rejeita o alias jest — o vitest o obedece, nós não", () => {
    const achados = auditarDiretivas([fixture("alias-jest.txt")]);
    expect(achados).toHaveLength(1);
    expect(achados[0].msg).toContain("alias");
  });

  it("rejeita ambiente fora da allowlist", () => {
    const achados = auditarDiretivas([fixture("valor-invalido.txt")]);
    expect(achados).toHaveLength(1);
    expect(achados[0].msg).toContain("happy-dom");
    expect(AMBIENTES_PERMITIDOS).toEqual(["jsdom", "node"]);
  });

  it("rejeita a diretiva de opções", () => {
    const achados = auditarDiretivas([fixture("opcoes.txt")]);
    expect(achados).toHaveLength(1);
    expect(achados[0].msg).toContain("options");
  });

  it("aceita a diretiva na PRIMEIRA linha do arquivo", () => {
    // Fronteira de baixo do cabeçalho. `linhaDe` conta a partir de 1, e um off-by-one aqui
    // reprovaria justamente a forma canônica (docblock na linha 1) — os 22 arquivos do repo que
    // usam a diretiva a põem na linha 1 ou 2.
    expect(auditarDiretivas([{ caminho: "x", texto: `// ${DIR} node\nconst a = 1;\n` }])).toEqual([]);
  });
});

// ── denominador ────────────────────────────────────────────────────────────────────────────────
// O gate audita a UNIÃO dos `include` dos `test.projects`. Um denominador menor que a suíte é
// verde por AUSÊNCIA — por isso as três formas degeneradas LANÇAM em vez de auditar menos.
describe("globsDosProjects — denominador fail-CLOSED", () => {
  it("une os include de TODOS os projects, não só o primeiro", () => {
    expect(
      globsDosProjects({
        test: {
          projects: [
            { test: { name: "node", include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] } },
            { test: { name: "dom", include: ["src/**/*.test.tsx"] } },
          ],
        },
      }),
    ).toEqual(["src/**/*.test.ts", "scripts/**/*.test.ts", "src/**/*.test.tsx"]);
  });

  it("lança quando não há projects", () => {
    expect(() => globsDosProjects({ test: {} })).toThrow(/test\.projects/);
    expect(() => globsDosProjects({ test: { projects: [] } })).toThrow(/test\.projects/);
    expect(() => globsDosProjects({})).toThrow(/test\.projects/);
  });

  it("lança quando um project não declara include próprio", () => {
    // Sem `include` o project cai no default do vitest (ou herda a raiz por `extends`): roda
    // arquivo que o gate não enxerga. É a forma mais silenciosa de o denominador encolher.
    expect(() =>
      globsDosProjects({
        test: {
          projects: [
            { test: { name: "node", include: ["src/**/*.test.ts"] } },
            { test: { name: "dom" } },
          ],
        },
      }),
    ).toThrow(/não declara include próprio/);
    expect(() =>
      globsDosProjects({ test: { projects: [{ test: { name: "dom", include: [] } }] } }),
    ).toThrow(/não declara include próprio/);
  });

  it("lança quando o include tem entrada não-string", () => {
    expect(() =>
      globsDosProjects({ test: { projects: [{ test: { include: [123] } }] } }),
    ).toThrow(/não-string/);
  });

  it("o denominador REAL do repo cobre os dois projects do vitest.config.ts", async () => {
    // Import dinâmico pelo mesmo motivo documentado no gate: o estático derruba o vitest ao
    // montar o grafo (o config carrega o plugin react-swc).
    const { default: config } = await import("../vitest.config");
    const globs = globsDosProjects(config as Parameters<typeof globsDosProjects>[0]);
    // Prova por PROPRIEDADE, não por lista literal: a lista viraria o espelho que o gate
    // recusa ser. Exigimos que a união cubra as duas extensões — se um project sumir do
    // config, uma das duas some daqui e este teste fica vermelho.
    expect(globs.some((g) => g.endsWith(".ts"))).toBe(true);
    expect(globs.some((g) => g.endsWith(".tsx"))).toBe(true);
    expect(globs.some((g) => g.startsWith("scripts/"))).toBe(true);
  });
});

describe("gate de diretiva de ambiente — alfabeto", () => {
  it("este arquivo NÃO trocou o próprio ambiente", () => {
    // Auto-sonda. Este arquivo monta literais da diretiva para provar o alfabeto do gate, e o
    // vitest lê a diretiva por REGEX NO TEXTO INTEIRO: escrever o literal completo aqui — mesmo
    // dentro de uma string, mesmo negando em prosa — trocaria o ambiente deste teste em silêncio.
    // O rótulo da saída (`|node|`) é o nome do PROJECT e não denuncia a troca; esta asserção sim.
    // Via `globalThis`, e não `typeof document`: `tsconfig.scripts.json` não carrega a lib `dom`,
    // então o identificador nu é TS2584 aqui (só no 2º tsc do `typecheck` — o 1º, de `src/`, passa).
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
  });


  it("casa o mesmo alfabeto do vitest — o regex do gate reconhece o que o vitest reconhece", () => {
    // Prova por CONSTRUÇÃO, não por leitura: monta o literal e confere que o gate o vê.
    const texto = `// ${DIR} node\n`;
    expect(auditarDiretivas([{ caminho: "x", texto }])).toEqual([]);
    const textoJest = `// @jest-${"environment"} node\n`;
    expect(auditarDiretivas([{ caminho: "x", texto: textoJest }])).toHaveLength(1);
  });
});
