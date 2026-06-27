import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard de paridade — corpo de gerar_pedidos_sugeridos_ciclo (money-path).
 *
 * O #1090 (motor escolhe galão econômico + consolida grupo) entrou em PROD via
 * db/embalagem-motor-rpc.sql, FORA de supabase/migrations/. Ao formalizá-lo como migration
 * (reconciliação retroativa), o SQL da função passou a viver em DOIS arquivos:
 *   - db/embalagem-motor-rpc.sql                                    ← fixture de db/test-embalagem-motor.sh
 *   - supabase/migrations/<ts>_reposicao_embalagem_motor_galao.sql ← migration formal
 * Como o teste PG17 só exercita a fixture, sem este guard os dois driftam em SILÊNCIO
 * (database.md §2). Editar um sem o outro quebra o CI aqui. Mantenha-os byte-idênticos do
 * CREATE OR REPLACE até o fim do arquivo (inclui qualquer ALTER/GRANT que venha DEPOIS da função
 * — blind spot apontado pelo /codex challenge: comparar só até $function$; ignoraria SQL extra).
 */
const ROOT = process.cwd();
const FIXTURE = join(ROOT, "db", "embalagem-motor-rpc.sql");
const MIG_DIR = join(ROOT, "supabase", "migrations");
const MIG_SUFFIX = "_reposicao_embalagem_motor_galao.sql";
const ABRE = "CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo";

/** Do CREATE OR REPLACE até o FIM do arquivo (pega SQL extra após $function$;), com exatamente 1 CREATE. */
function sqlDaFuncao(sql: string, origem: string): string {
  const ini = sql.indexOf(ABRE);
  expect(ini, `"${ABRE}" ausente em ${origem}`).toBeGreaterThanOrEqual(0);
  expect(sql.indexOf(ABRE, ini + ABRE.length), `mais de um CREATE da função em ${origem} (extração ambígua)`).toBe(-1);
  return sql.slice(ini).trimEnd();
}

/** Resolve a migration por sufixo, exigindo que exista EXATAMENTE uma (find() silencioso pegaria a 1ª). */
function migrationUnica(): string {
  const matches = readdirSync(MIG_DIR).filter((f) => f.endsWith(MIG_SUFFIX));
  expect(matches, `esperava 1 migration *${MIG_SUFFIX}, achei ${matches.length}: ${matches.join(", ")}`).toHaveLength(1);
  return matches[0];
}

describe("paridade embalagem-motor (fixture db/ ↔ migration formal)", () => {
  it("existe exatamente UMA migration *_reposicao_embalagem_motor_galao.sql", () => {
    migrationUnica();
  });

  it("SQL da função (CREATE → fim do arquivo) é idêntico nos dois", () => {
    const fix = sqlDaFuncao(readFileSync(FIXTURE, "utf8"), "db/embalagem-motor-rpc.sql");
    const migName = migrationUnica();
    const mig = sqlDaFuncao(readFileSync(join(MIG_DIR, migName), "utf8"), migName);
    expect(mig).toBe(fix);
  });
});
