// A allowlist é DEFAULT-DENY e versionada: este teste guarda a forma dela.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-cron-alvos_test.ts
import { SONDA_CRON_ALVOS, slugsDaAllowlist } from "./sonda-cron-alvos.ts";

function assert(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
}

Deno.test("allowlist: slugs válidos, únicos, com ≥1 controle positivo cada e o relé presente", () => {
  const vistos = new Set<string>();
  for (const a of SONDA_CRON_ALVOS) {
    assert(/^[a-z0-9-]{1,80}$/.test(a.edge), `slug fora do formato: ${a.edge}`);
    assert(!vistos.has(a.edge), `slug repetido: ${a.edge}`);
    vistos.add(a.edge);
    assert(a.controles.length >= 1, `${a.edge}: sem controle positivo — a prova não teria como saber se o contador enxerga o fluxo real`);
    for (const c of a.controles) {
      assert(c.metodo === "POST", `${a.edge}: controle com método ${c.metodo}`);
      assert(c.nota.length >= 20, `${a.edge}: controle sem nota que explique a época de autenticação`);
    }
    assert(a.desde === null || /^[0-9a-f]{7,40}$/.test(a.desde), `${a.edge}: desde inválido: ${a.desde}`);
  }
  assert(slugsDaAllowlist().has("sonda-relay"), "o relé precisa estar na própria allowlist (ele também se atesta)");
  assert(slugsDaAllowlist().size === SONDA_CRON_ALVOS.length, "slugsDaAllowlist ≠ lista");
});

Deno.test("allowlist: as edges perigosas conhecidas NÃO estão nela sem prova", () => {
  // `omie-webhook` é a única das 54 cuja ordem no handler foge do padrão (classifica a sonda antes
  // do gate). Ela só entra com `controles` próprios (x-webhook-secret) e 100 % dos closures PASSA.
  assert(!slugsDaAllowlist().has("omie-webhook"), "omie-webhook entrou na allowlist sem a prova executada");
});
