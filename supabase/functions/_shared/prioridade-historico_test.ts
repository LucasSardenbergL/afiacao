// Comportamento da regra que decide o priority_score GRAVADO por status de histórico.
// Sem import remoto: `test:edges` roda com `--no-remote`.

import { prioridadeNoRefreshFatal, prioridadePorStatus } from "./prioridade-historico.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (!Object.is(a, b)) {
    throw new Error(msg ?? `assertEquals falhou: ${String(a)} !== ${String(b)}`);
  }
}

Deno.test("[PRIO-HIST] run saudável: sem_historico → null (o 67 de prod não sobrevive)", () => {
  assertEquals(prioridadePorStatus("sem_historico", 67), null);
  // 0 calculado também vira null: o critério é o status, não o valor.
  assertEquals(prioridadePorStatus("sem_historico", 0), null);
});

Deno.test("[PRIO-HIST] run saudável: comprador mantém o cálculo, inclusive 0", () => {
  assertEquals(prioridadePorStatus("ativo", 30), 30);
  assertEquals(prioridadePorStatus("stale", 54), 54);
  assertEquals(prioridadePorStatus("ativo", 0), 0, "0 medido de comprador não vira null");
});

Deno.test("[PRIO-HIST] primeira venda no mesmo run: status derivado agora (ativo) vence o persistido", () => {
  // O index passa o status DERIVADO neste run para prioridadePorStatus; o persistido (sem_historico)
  // só importa no ramo fatal. Um cliente que acabou de comprar ganha prioridade calculada.
  assertEquals(prioridadePorStatus("ativo", 45), 45);
});

Deno.test("[PRIO-HIST] refresh fatal: status persistido sem_historico → null", () => {
  assertEquals(prioridadeNoRefreshFatal("sem_historico", 67, 67), null);
});

Deno.test("[PRIO-HIST] refresh fatal: ativo/stale persistido → cálculo do run", () => {
  assertEquals(prioridadeNoRefreshFatal("ativo", 31, 30), 31);
  assertEquals(prioridadeNoRefreshFatal("stale", 50, 54), 50);
});

Deno.test("[PRIO-HIST] refresh fatal: status NULL no banco → preserva a prioridade anterior", () => {
  assertEquals(prioridadeNoRefreshFatal(null, 67, 42), 42, "não usa o cálculo");
  assertEquals(prioridadeNoRefreshFatal(null, 67, null), null, "anterior nulo segue nulo");
  assertEquals(prioridadeNoRefreshFatal(undefined, 67, 42), 42, "coluna ausente no select = desconhecido");
  assertEquals(prioridadeNoRefreshFatal("lixo", 67, 42), 42, "valor fora do domínio = desconhecido");
});
