// `eq` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
import { portalSayerlackFechado } from "./janela-portal.ts";

function eq(atual: unknown, esperado: unknown, msg: string) {
  if (atual !== esperado) throw new Error(`${msg}: esperado ${esperado}, veio ${atual}`);
}

// Instantes em UTC; SP = UTC−3 (sem horário de verão desde 2019). 10/10/2026 é sábado.
const casos: Array<[string, boolean, string]> = [
  ["2026-10-10T14:59:00Z", false, "sábado 11:59 SP — aberto"],
  ["2026-10-10T15:00:00Z", true, "sábado 12:00 SP — fecha"],
  ["2026-10-11T02:30:00Z", true, "sábado 23:30 SP (domingo em UTC) — fechado"],
  ["2026-10-11T15:00:00Z", true, "domingo meio-dia — fechado"],
  ["2026-10-12T08:59:00Z", true, "segunda 05:59 SP — fechado"],
  ["2026-10-12T09:00:00Z", false, "segunda 06:00 SP — abre"],
  ["2026-10-12T02:00:00Z", true, "domingo 23:00 SP (segunda em UTC) — fechado"],
  ["2026-10-09T23:00:00Z", false, "sexta 20:00 SP — aberto"],
  ["2026-10-14T13:00:00Z", false, "quarta 10:00 SP — aberto"],
];

for (const [iso, esperado, rotulo] of casos) {
  Deno.test(`janela do portal: ${rotulo}`, () => {
    eq(portalSayerlackFechado(new Date(iso)), esperado, rotulo);
  });
}
