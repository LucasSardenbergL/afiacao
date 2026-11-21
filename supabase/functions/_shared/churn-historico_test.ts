// Comportamento da regra que decide o churn_risk GRAVADO por status de histórico.
// Sem import remoto: `test:edges` roda com `--no-remote`.

import { churnNoRefreshFatal, churnPorStatus } from "./churn-historico.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (!Object.is(a, b)) {
    throw new Error(msg ?? `assertEquals falhou: ${String(a)} !== ${String(b)}`);
  }
}

Deno.test("[CHURN-HIST] run saudável: sem_historico → null (o 100 de prod não sobrevive)", () => {
  assertEquals(churnPorStatus("sem_historico", 100), null);
  // 0 calculado também vira null: o critério é o status, não o valor.
  assertEquals(churnPorStatus("sem_historico", 0), null);
});

Deno.test("[CHURN-HIST] run saudável: comprador mantém o cálculo, inclusive 100 e 0", () => {
  assertEquals(churnPorStatus("ativo", 39), 39);
  assertEquals(churnPorStatus("stale", 100), 100, "stale com health 0 tem churn 100 LEGÍTIMO");
  assertEquals(churnPorStatus("ativo", 0), 0, "0 medido de comprador não vira null");
});

Deno.test("[CHURN-HIST] primeira venda no mesmo run: status derivado agora (ativo) vence o persistido", () => {
  assertEquals(churnPorStatus("ativo", 72), 72);
});

Deno.test("[CHURN-HIST] refresh fatal: status persistido sem_historico → null", () => {
  assertEquals(churnNoRefreshFatal("sem_historico", 100, 100), null);
});

Deno.test("[CHURN-HIST] refresh fatal: ativo/stale persistido → cálculo do run", () => {
  assertEquals(churnNoRefreshFatal("ativo", 41, 40), 41);
  assertEquals(churnNoRefreshFatal("stale", 93, 90), 93);
});

Deno.test("[CHURN-HIST] refresh fatal: status NULL no banco → preserva o churn anterior", () => {
  assertEquals(churnNoRefreshFatal(null, 100, 42), 42, "não usa o cálculo");
  assertEquals(churnNoRefreshFatal(null, 100, null), null, "anterior nulo segue nulo");
  assertEquals(churnNoRefreshFatal(undefined, 100, 42), 42, "coluna ausente no select = desconhecido");
  assertEquals(churnNoRefreshFatal("lixo", 100, 42), 42, "valor fora do domínio = desconhecido");
});
