import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODULOS } from "../manifesto";
import { ROTA_DESTINO, moduloDaRota, rotaCongelada } from "../congelamento";
import type { Congelamento } from "../tipos";

// GATE do congelamento (M-41): módulo congelado não tem rota visível. A rota passa pelo
// GuardModuloCongelado (redireciona) e o item some da navegação do AppShell — os dois leem
// `rotaCongelada`, então o que este gate prende é (a) os dados do manifesto e (b) que o App.tsx
// e o AppShell continuam ligados a ela.

const APP = readFileSync("src/App.tsx", "utf8");
const SHELL = readFileSync("src/components/AppShell.tsx", "utf8");

/** Rotas declaradas no App.tsx, absolutas, com `:param` trocado por um valor concreto. */
const ROTAS_APP = [...APP.matchAll(/<Route\s+(?:index\s+)?path="([^"]+)"/g)]
  .map((m) => (m[1].startsWith("/") ? m[1] : `/${m[1]}`))
  .filter((r) => r !== "/*")
  .map((r) => r.replace(/:[A-Za-z]+/g, "x"));

const DIA_MS = 86_400_000;
function conferePrazo(c: Congelamento, onde: string) {
  expect(c.desde, `${onde}: desde ISO`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(c.ate, `${onde}: ate ISO`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const dias = (Date.parse(`${c.ate}T00:00:00Z`) - Date.parse(`${c.desde}T00:00:00Z`)) / DIA_MS;
  expect(dias, `${onde}: congelamento é de 90 dias`).toBe(90);
  expect(c.motivo.trim().length, `${onde}: motivo`).toBeGreaterThan(20);
}

describe("GATE: módulo congelado não tem rota visível (M-41)", () => {
  it("o parser do App.tsx enxerga as rotas (senão o resto do gate passa no vazio)", () => {
    expect(ROTAS_APP.length).toBeGreaterThan(100);
    expect(ROTAS_APP).toContain("/admin/estoque/picking");
  });

  it("todo módulo não-ativo tem prazo de 90 dias e motivo; plataforma nunca congela", () => {
    for (const m of MODULOS) {
      if (m.kind === "plataforma") expect(m.status, m.id).toBe("ativo");
      if (m.status === "ativo") expect(m.congelamento, `${m.id}: ativo sem congelamento`).toBeUndefined();
      else conferePrazo(m.congelamento!, m.id);
      if (m.rotasCongeladas) {
        expect(m.status, `${m.id}: congelamento parcial só em módulo ativo`).toBe("ativo");
        conferePrazo(m.rotasCongeladas, `${m.id} (parcial)`);
      }
    }
  });

  it(`"${ROTA_DESTINO}" nunca congela — é o destino do redirect`, () => {
    expect(rotaCongelada(ROTA_DESTINO, MODULOS)).toBeNull();
  });

  it("todo prefixo congelado casa ≥1 rota do App.tsx (congelamento morto = digitação errada)", () => {
    const prefixos = MODULOS.flatMap((m) => [
      ...(m.status !== "ativo" ? m.rotaPrefixos.filter((p) => p !== ROTA_DESTINO) : []),
      ...(m.rotasCongeladas?.prefixos ?? []),
    ]);
    const mortos = prefixos.filter((p) => !ROTAS_APP.some((r) => r === p || r.startsWith(`${p}/`)));
    expect(mortos).toEqual([]);
  });

  it("toda rota do App.tsx cujo dono está congelado é barrada pelo guard", () => {
    const escapam = ROTAS_APP.filter((r) => {
      const dono = moduloDaRota(r, MODULOS);
      return r !== ROTA_DESTINO && dono && dono.status !== "ativo" && !rotaCongelada(r, MODULOS);
    });
    expect(escapam).toEqual([]);
  });

  it("o GuardModuloCongelado envolve TODAS as rotas autenticadas do App.tsx", () => {
    // A rota do shell abre e, antes de qualquer outra <Route>, vem a do guard.
    const shell = APP.indexOf("<ProtectedRoute><AppShellLayout /></ProtectedRoute>");
    expect(shell).toBeGreaterThan(-1);
    const proxima = APP.slice(shell).split("\n").slice(1).find((l) => l.includes("<Route"));
    expect(proxima?.trim()).toBe("<Route element={<GuardModuloCongelado />}>");
  });

  it("a navegação do AppShell só lê a lista filtrada (navSections)", () => {
    const usos = [...SHELL.matchAll(/unifiedNavSections|docNavSection/g)].length;
    // 2 definições + 1 uso na construção de navSections — qualquer outro uso fura o filtro.
    expect(usos).toBe(4);
    expect(SHELL).toMatch(/filter\(\(it\) => !rotaCongelada\(it\.path, MODULOS\)\)/);
  });
});
