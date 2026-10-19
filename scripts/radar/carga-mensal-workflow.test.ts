import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// As invariantes do YAML são parte da entrega: uma carga que roda duas vezes em paralelo mistura chunks
// de dois executores; um `cancel-in-progress` deixa lote `running` órfão; sem `workflow_dispatch` a 1ª
// execução real (que libera o check da Sentinela) não existe; secret inline vazaria no repo público.

interface Passo { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; if?: string; env?: Record<string, unknown> }
interface Job { "runs-on"?: string; "timeout-minutes"?: number; env?: Record<string, unknown>; steps?: Passo[] }
interface Workflow {
  on?: { schedule?: { cron: string }[]; workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const RAIZ = join(__dirname, "..", "..");
const texto = readFileSync(join(RAIZ, ".github", "workflows", "radar-carga-mensal.yml"), "utf8");
const wf = parse(texto) as Workflow;
const job = (): Job => Object.values(wf.jobs ?? {})[0] ?? {};
const passos = (): Passo[] => job().steps ?? [];
const bunDoCi = (): string => {
  const ci = readFileSync(join(RAIZ, ".github", "workflows", "ci.yml"), "utf8");
  return /bun-version:\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(ci)?.[1] ?? "";
};

describe("workflow radar-carga-mensal", () => {
  it("[WF1] sonda semanal (segunda, 06:00 UTC = 03:00 BRT) + workflow_dispatch com mes e forcar", () => {
    expect(wf.on?.schedule).toEqual([{ cron: "0 6 * * 1" }]);
    const inputs = wf.on?.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(["forcar", "mes"]);
    expect(inputs.forcar?.type).toBe("boolean");
    expect(inputs.forcar?.default).toBe(false);
  });

  it("[WF2] um job só, serializado por concurrency SEM cancelar a carga em andamento", () => {
    expect(Object.keys(wf.jobs ?? {})).toHaveLength(1);
    expect(wf.concurrency?.group).toBe("radar-carga-mensal");
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("[WF3] teto de tempo folgado (≥ 300 min) dentro do limite de 6 h do runner, permissões mínimas", () => {
    const t = job()["timeout-minutes"] ?? 0;
    expect(t).toBeGreaterThanOrEqual(300);
    expect(t).toBeLessThanOrEqual(360);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job()["runs-on"]).toBe("ubuntu-latest");
  });

  it("[WF4] segredo só via secrets.RADAR_CRON_SECRET, com guarda fail-closed antes de qualquer download", () => {
    expect(job().env?.RADAR_CRON_SECRET).toBe("${{ secrets.RADAR_CRON_SECRET }}");
    // Nenhum valor literal parecido com segredo no arquivo (repo público).
    expect(texto).not.toMatch(/x-cron-secret:\s*[A-Za-z0-9]{16,}/);
    const iGuarda = passos().findIndex((p) => /Segredo presente/.test(p.name ?? ""));
    const iDuck = passos().findIndex((p) => /DuckDB/.test(p.name ?? ""));
    expect(iGuarda).toBeGreaterThan(-1);
    expect(iGuarda).toBeLessThan(iDuck);
    expect(passos()[iGuarda]?.run).toContain("exit 1");
  });

  it("[WF5] trabalho em /mnt com guarda de espaço e zips apagados; DuckDB pinado por sha256", () => {
    expect(job().env?.RADAR_WORK_DIR).toBe("/mnt/radar");
    expect(job().env?.RADAR_APAGAR_ZIPS).toBe("1");
    const disco = passos().find((p) => /Disco de trabalho/.test(p.name ?? ""));
    expect(disco?.run).toMatch(/-lt 40/);
    expect(disco?.run).toContain("exit 1");
    const duck = passos().find((p) => /DuckDB/.test(p.name ?? ""));
    expect(duck?.run).toMatch(/releases\/download\/v1\.5\.4\//);
    expect(duck?.run).toMatch(/[0-9a-f]{64}\s+\/tmp\/duckdb\.zip/);
    expect(duck?.run).toContain("sha256sum -c");
  });

  it("[WF6] carga só roda quando o seletor escolheu um mês, e usa o mês escolhido", () => {
    const carga = passos().find((p) => /^Carga/.test(p.name ?? ""));
    expect(carga?.if).toBe("steps.mes.outputs.mes != ''");
    expect(carga?.run).toContain("scripts/radar/carga.ts --mes \"${{ steps.mes.outputs.mes }}\"");
    const seletor = passos().find((p) => /Escolher o mês/.test(p.name ?? ""));
    expect(seletor?.run).toContain("scripts/radar/mes-alvo.ts");
  });

  it("[WF8] inputs do dispatch entram por env, nunca interpolados no shell (injeção com o segredo no ambiente)", () => {
    const seletor = passos().find((p) => /Escolher o mês/.test(p.name ?? ""));
    expect(seletor?.env?.MES_PEDIDO).toBe("${{ inputs.mes }}");
    expect(seletor?.env?.FORCAR).toBe("${{ inputs.forcar }}");
    for (const p of passos()) expect(p.run ?? "").not.toMatch(/\$\{\{\s*inputs\./);
  });

  it("[WF7] bun pinado na MESMA versão do ci.yml (bunpin)", () => {
    const setup = passos().find((p) => /setup-bun/.test(p.uses ?? ""));
    expect(setup?.with?.["bun-version"]).toBe(bunDoCi());
    expect(bunDoCi()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
