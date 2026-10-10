// `eq` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
import { digestSuprimidoNoDia } from "./digest-dia.ts";

function eq(atual: unknown, esperado: unknown, msg: string) {
  if (atual !== esperado) throw new Error(`${msg}: esperado ${esperado}, veio ${atual}`);
}

Deno.test("digest: domingo 04/10/2026 é suprimido", () => {
  eq(digestSuprimidoNoDia("2026-10-04"), true, "domingo");
});

Deno.test("digest: sábado 03/10 e segunda 05/10 seguem com e-mail", () => {
  eq(digestSuprimidoNoDia("2026-10-03"), false, "sábado");
  eq(digestSuprimidoNoDia("2026-10-05"), false, "segunda");
});

Deno.test("digest: data inválida não suprime", () => {
  eq(digestSuprimidoNoDia("lixo"), false, "inválida");
});
