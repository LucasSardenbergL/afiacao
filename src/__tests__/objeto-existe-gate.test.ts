import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removerComentarios } from "@/lib/gates/limpeza-fonte";

// GATE objeto-existe (M-06, plano 2026-09-05): `.from("x")`/`.rpc("x")` com literal em src/ só
// passa se `x` EXISTE no banco — no `schema-snapshot.sql` (dump da PROD) ou numa migration
// posterior ao dump. Incidente: `fila_aplicacao_omie`/`gerar_fila_aplicacao_omie` e
// `quality_checklists` nunca existiram em prod, e as telas (Aplicação Omie, etapa 4 da sessão de
// reposição; Checklist de Qualidade) ficaram no ar falhando em silêncio — o `as never` e o
// `error → 0` esconderam o 404 do PostgREST do typecheck e do usuário.

const SNAPSHOT = readFileSync("supabase/schema-snapshot.sql", "utf8");
const MANIFEST = readFileSync("supabase/schema-snapshot.manifest.md", "utf8");
const DIR_MIGRATIONS = "supabase/migrations";

/** Data do dump (AAAA-MM-DD). Migration com prefixo >= essa data pode ainda não estar no snapshot. */
const DATA_SNAPSHOT = MANIFEST.match(/\|\s*Gerado em\s*\|\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";

const OBJETOS_SNAPSHOT = new Set(
  [...SNAPSHOT.matchAll(/^CREATE (?:TABLE|VIEW|MATERIALIZED VIEW|FUNCTION) public\.([A-Za-z0-9_]+)/gm)].map((m) => m[1]),
);

const OBJETOS_MIGRATIONS_RECENTES = new Set(
  readdirSync(DIR_MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && f.slice(0, 8) >= DATA_SNAPSHOT.replace(/-/g, ""))
    .flatMap((f) => [
      ...readFileSync(join(DIR_MIGRATIONS, f), "utf8").matchAll(
        /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z0-9_]+)/gi,
      ),
    ])
    .map((m) => m[1]),
);

/**
 * Catraca: fantasmas conhecidos FORA do escopo do M-06. Só encolhe — entrada que deixa de ser
 * fantasma (corrigida ou o objeto passou a existir) reprova até sair daqui.
 */
const BASELINE: Record<string, string> = {
  call_logs: "PerformanceHub 'Ligações Hoje' — safeQuery cai em 0 (a tabela real é call_log)",
  sales_print_jobs: "VendasFerramentas — KPI de impressões, safeQuery cai em 0",
};

/** Identificador imediatamente antes do `.from`/`.rpc` — `storage`/`Array` não são tabela. */
const NAO_E_BANCO = new Set(["storage", "Array", "Buffer", "Uint8Array"]);

function arquivosFonte(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : arquivosFonte(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

type Sitio = { nome: string; onde: string };
const SITIOS: Sitio[] = arquivosFonte("src").flatMap((arq) => {
  const fonte = removerComentarios(readFileSync(arq, "utf8"));
  return [...fonte.matchAll(/([A-Za-z_$][\w$]*)?\s*\.\s*(?:from|rpc)\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)]
    .filter((m) => !NAO_E_BANCO.has(m[1] ?? ""))
    .map((m) => ({ nome: m[2], onde: `${arq}:${fonte.slice(0, m.index).split("\n").length}` }));
});

const existe = (nome: string) => OBJETOS_SNAPSHOT.has(nome) || OBJETOS_MIGRATIONS_RECENTES.has(nome);

describe("GATE objeto-existe: .from()/.rpc() só de objeto que existe no banco (M-06)", () => {
  it("pisos: snapshot, data do dump e varredura enxergam o universo (senão o gate passa no vazio)", () => {
    expect(DATA_SNAPSHOT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(OBJETOS_SNAPSHOT.size).toBeGreaterThan(700);
    expect(SITIOS.length).toBeGreaterThan(1000);
    expect(OBJETOS_SNAPSHOT.has("profiles")).toBe(true);
  });

  it("nenhum nome ausente do banco fora da catraca", () => {
    const fantasmas = SITIOS.filter((s) => !existe(s.nome) && !(s.nome in BASELINE)).map((s) => `${s.nome} @ ${s.onde}`);
    expect(fantasmas).toEqual([]);
  });

  it("a catraca só encolhe: toda entrada ainda é um fantasma usado em src/", () => {
    const vencidas = Object.keys(BASELINE).filter((n) => existe(n) || !SITIOS.some((s) => s.nome === n));
    expect(vencidas).toEqual([]);
  });
});
