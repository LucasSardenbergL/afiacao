import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard de paridade — corpo de gerar_pedidos_sugeridos_ciclo (money-path).
 *
 * A função vive em DOIS lugares que TÊM de casar:
 *   - db/embalagem-motor-rpc.sql                       ← fixture VIVA (motor galão + gate estoque-não-confirmado),
 *                                                         exercitada por db/test-embalagem-motor.sh e db/test-gate-*.sh
 *   - a ÚLTIMA migration que recria a função (maior ts) ← o que vai a prod ("última a recriar vence", database.md §2)
 *
 * O #1090 (galão) entrou em prod via db/embalagem-motor-rpc.sql FORA de supabase/migrations/; depois foi
 * formalizado como migration. O gate (2026-06-27) recria a função numa migration POSTERIOR. Sem este guard a
 * fixture e a migration que vence em prod driftam em SILÊNCIO. Editar um sem o outro quebra o CI aqui.
 * Compara do CREATE OR REPLACE até o FIM do arquivo (pega ALTER/GRANT após $function$; — blind spot do /codex).
 */
const ROOT = process.cwd();
const FIXTURE = join(ROOT, "db", "embalagem-motor-rpc.sql");
const MIG_DIR = join(ROOT, "supabase", "migrations");
const ABRE = "CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo";

/** Do CREATE OR REPLACE até o FIM do arquivo (pega SQL extra após $function$;), com exatamente 1 CREATE. */
function sqlDaFuncao(sql: string, origem: string): string {
  const ini = sql.indexOf(ABRE);
  expect(ini, `"${ABRE}" ausente em ${origem}`).toBeGreaterThanOrEqual(0);
  expect(sql.indexOf(ABRE, ini + ABRE.length), `mais de um CREATE da função em ${origem} (extração ambígua)`).toBe(-1);
  return sql.slice(ini).trimEnd();
}

/**
 * A migration de MAIOR timestamp que recria a função — a que VENCE em prod. Os nomes começam com o timestamp
 * (ordenáveis lexicograficamente), então o último do sort é o mais recente. Exige >= 1 (find() silencioso mascararia).
 */
function ultimaMigrationDaFuncao(): string {
  const matches = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && readFileSync(join(MIG_DIR, f), "utf8").includes(ABRE))
    .sort();
  expect(matches.length, `nenhuma migration recria ${ABRE} (esperava >= 1)`).toBeGreaterThan(0);
  return matches[matches.length - 1];
}

describe("paridade do motor (fixture db/ ↔ última migration que recria a função)", () => {
  it("a fixture viva bate com a última migration que recria a função", () => {
    const fix = sqlDaFuncao(readFileSync(FIXTURE, "utf8"), "db/embalagem-motor-rpc.sql");
    const migName = ultimaMigrationDaFuncao();
    const mig = sqlDaFuncao(readFileSync(join(MIG_DIR, migName), "utf8"), migName);
    expect(mig, `db/embalagem-motor-rpc.sql diverge da migration ${migName} (corpo da função money-path)`).toBe(fix);
  });
});
