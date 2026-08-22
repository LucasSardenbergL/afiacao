// Testa o CÓDIGO REAL de `fetchAllKeyset` (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/paginate-keyset_test.ts
//
// O par de testes que importa é o de FALSIFICAÇÃO: o MESMO cenário de mutação
// (um DELETE antes do cursor, entre duas páginas) roda contra `fetchAll` (offset)
// e contra `fetchAllKeyset`. O primeiro PULA uma linha; o segundo não. Sem o
// primeiro, o segundo não prova nada — provaria só que um laço que ninguém
// perturbou devolve o que colocaram nele.
import { fetchAll, fetchAllKeyset } from "./paginate.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

async function assertLanca(fn: () => Promise<unknown>, trecho: string) {
  let msg: string | null = null;
  try {
    await fn();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  if (msg === null) throw new Error(`esperava lançar contendo ${JSON.stringify(trecho)}, mas resolveu`);
  if (!msg.includes(trecho)) throw new Error(`mensagem ${JSON.stringify(msg)} não contém ${JSON.stringify(trecho)}`);
}

/** Linhas com `id` numérico crescente — o análogo do uuid único e ordenável. */
function linhas(total: number) {
  return Array.from({ length: total }, (_, i) => ({ id: i, nome: `linha-${i}` }));
}

/** Fake KEYSET: devolve as `limite` primeiras linhas com `id > cursor`, do estado ATUAL. */
function fakeKeyset(estado: () => Array<{ id: number }>, aoLer?: (n: number) => void) {
  let calls = 0;
  const build = (cursor: number | null, limite: number) => {
    calls++;
    const atual = estado();
    const janela = atual.filter((l) => cursor === null || l.id > cursor).slice(0, limite);
    aoLer?.(calls); // muta DEPOIS de servir: é o que torna a escrita CONCORRENTE
    return Promise.resolve({ data: janela, error: null });
  };
  return { build, calls: () => calls };
}

/** Fake OFFSET: o `.range(from,to)` do PostgREST sobre o estado ATUAL (sem cap de 1000). */
function fakeOffset(estado: () => Array<{ id: number }>, aoLer?: (n: number) => void) {
  let calls = 0;
  const build = (from: number, to: number) => {
    calls++;
    const janela = estado().slice(from, to + 1);
    aoLer?.(calls); // muta DEPOIS de servir: é o que torna a escrita CONCORRENTE
    return Promise.resolve({ data: janela, error: null });
  };
  return { build, calls: () => calls };
}

// ── Paridade com fetchAll: o keyset lê a tabela inteira quando nada muda ──────────────

Deno.test("keyset: abaixo do cap, 1 request", async () => {
  const dados = linhas(292);
  const t = fakeKeyset(() => dados);
  const rows = await fetchAllKeyset<{ id: number }, number>(t.build, (l) => l.id, "t");
  assertEquals(rows.length, 292);
  assertEquals(t.calls(), 1);
});

Deno.test("keyset: acima do cap, devolve a cauda inteira em 3 requests", async () => {
  const dados = linhas(2300);
  const t = fakeKeyset(() => dados);
  const rows = await fetchAllKeyset<{ id: number }, number>(t.build, (l) => l.id, "t");
  assertEquals(rows.length, 2300);
  assertEquals(rows[2299].id, 2299);
  assertEquals(t.calls(), 3);
});

Deno.test("keyset: exatamente no cap, 1 request extra vazio, sem duplicar", async () => {
  const dados = linhas(1000);
  const t = fakeKeyset(() => dados);
  const rows = await fetchAllKeyset<{ id: number }, number>(t.build, (l) => l.id, "t");
  assertEquals(rows.length, 1000);
  assertEquals(t.calls(), 2);
});

Deno.test("keyset: tabela vazia, 1 request, zero linhas", async () => {
  const t = fakeKeyset(() => []);
  const rows = await fetchAllKeyset<{ id: number }, number>(t.build, (l) => l.id, "t");
  assertEquals(rows.length, 0);
  assertEquals(t.calls(), 1);
});

// ── A FALSIFICAÇÃO: o mesmo DELETE, nos dois helpers ─────────────────────────────────
// Cenário real medido (docs/historico/paginacao-offset-janela.md): `sync-reprocess` roda
// `15 */2 * * *` e faz `.delete().in('id', diff.deletar)` em `order_items` enquanto o
// `recommend` (on-demand) lê as 2.849 linhas do cliente em 3 páginas.

Deno.test("offset SOB DELETE entre páginas: PULA uma linha (o defeito, caracterizado)", async () => {
  const dados = linhas(2300);
  // Depois da 1ª página, apaga a linha 0 — ANTES do offset corrente (1000).
  const t = fakeOffset(() => dados, (n) => {
    if (n === 1) dados.splice(0, 1);
  });
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  const vistos = new Set(rows.map((r) => r.id));
  // O PULO: o DELETE do id 0 puxou tudo uma casa para trás, então o offset 1000 da 2ª
  // página caiu no id 1001 e o 1000 nunca foi lido — apesar de existir o tempo todo.
  assertEquals(vistos.has(1000), false, "id 1000 foi PULADO pelo deslocamento do offset");
  // E o fantasma: o id 0 entra no resultado mesmo tendo sido apagado depois de servido.
  assertEquals(vistos.has(0), true, "id 0 foi lido antes do DELETE — leitura não-repetível");
  // A armadilha: 2.299 lidas para 2.299 sobreviventes. O TOTAL BATE. Contar linhas não
  // detecta este defeito em lugar nenhum — só a identidade detecta.
  assertEquals(rows.length, 2299);
});

Deno.test("keyset SOB O MESMO DELETE: não pula nenhuma linha sobrevivente", async () => {
  const dados = linhas(2300);
  const t = fakeKeyset(() => dados, (n) => {
    if (n === 1) dados.splice(0, 1);
  });
  const rows = await fetchAllKeyset<{ id: number }, number>(t.build, (l) => l.id, "t");
  const vistos = new Set(rows.map((r) => r.id));
  assertEquals(vistos.has(1000), true, "id 1000 NÃO pode ser pulado sob keyset");
  assertEquals(vistos.size, rows.length, "nenhuma duplicata");
  // 2.300 = as 2.299 sobreviventes + o id 0, lido antes de ser apagado. O keyset NÃO
  // promete snapshot (para isso só uma RPC): promete que nada é pulado nem repetido por
  // POSIÇÃO. Ler uma linha que morre logo depois continua possível, e é outra classe.
  assertEquals(rows.length, 2300);
});

Deno.test("keyset SOB INSERT antes do cursor: não duplica", async () => {
  const dados = linhas(2300);
  // uuid v4 cai em posição ALEATÓRIA: aqui, no meio da fatia já lida.
  const t = fakeKeyset(() => dados, (n) => {
    if (n === 1) dados.splice(500, 0, { id: -1, nome: "nova" } as { id: number; nome: string });
  });
  const rows = await fetchAllKeyset<{ id: number }, number>(t.build, (l) => l.id, "t");
  const vistos = new Set(rows.map((r) => r.id));
  assertEquals(vistos.size, rows.length, "nenhuma duplicata sob INSERT concorrente");
});

// ── Guardas do contrato do keyset ────────────────────────────────────────────────────

Deno.test("keyset: chave NÃO-ÚNICA (cursor não avança) LANÇA em vez de loop infinito", async () => {
  // Toda linha com a MESMA chave: `.gt(cursor)` devolveria sempre a mesma página.
  // Offset degrada em silêncio; keyset com chave repetida trava. Fail-closed.
  const dados = Array.from({ length: 2300 }, (_, i) => ({ id: i, grupo: 7 }));
  let calls = 0;
  const build = (cursor: number | null, limite: number) => {
    calls++;
    if (calls > 50) throw new Error("LOOP INFINITO: o helper não detectou cursor parado");
    const janela = dados.filter((l) => cursor === null || l.grupo >= cursor).slice(0, limite);
    return Promise.resolve({ data: janela, error: null });
  };
  // Detectado já na 1ª página pela varredura de ordem (7 → 7 viola a monotonia estrita),
  // antes de gastar um segundo request. A guarda de cursor entre páginas segue no helper
  // como rede de baixo, para a chave que só repete NA FRONTEIRA entre duas páginas.
  await assertLanca(
    () => fetchAllKeyset<{ id: number; grupo: number }, number>(build, (l) => l.grupo, "t"),
    "ÚNICA",
  );
});

Deno.test("keyset: data null SEM error LANÇA — malformada não é fim da tabela", async () => {
  const build = () => Promise.resolve({ data: null, error: null });
  await assertLanca(
    () => fetchAllKeyset<{ id: number }, number>(build, (l) => l.id, "minha_tabela"),
    "minha_tabela",
  );
});

Deno.test("keyset: erro lança com o label prefixado", async () => {
  const build = () => Promise.resolve({ data: null, error: { message: "boom" } });
  await assertLanca(
    () => fetchAllKeyset<{ id: number }, number>(build, (l) => l.id, "minha_tabela"),
    "minha_tabela: boom",
  );
});

Deno.test("keyset: página em ordem DECRESCENTE lança em vez de duplicar em massa", async () => {
  // O helper só recebe `build` — não enxerga o `.order()` do call-site. Um
  // `.order('id',{ascending:false})` combinado com `.gt(cursor)` faria o cursor andar
  // PARA TRÁS e reservir quase a mesma página: duplicação em massa, e a guarda de
  // "cursor parado" não pega, porque ele de fato muda a cada volta.
  const dados = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
  let calls = 0;
  const build = (cursor: number | null, limite: number) => {
    calls++;
    if (calls > 20) throw new Error("DUPLICAÇÃO EM MASSA: o helper não detectou ordem decrescente");
    const janela = dados.filter((l) => cursor === null || l.id > cursor)
      .sort((a, b) => b.id - a.id) // DESC, como o call-site pediu
      .slice(0, limite);
    return Promise.resolve({ data: janela, error: null });
  };
  await assertLanca(
    () => fetchAllKeyset<{ id: number }, number>(build, (l) => l.id, "t"),
    "ordem",
  );
});

// ── Caminho B (auto-challenge; Codex sem cota em 2026-08-21) ─────────────────────────
// Dois vetores que a primeira versão não cobria. Ambos falham em SILÊNCIO, que é o modo
// que esta entrega inteira existe para combater.

Deno.test("keyset: coluna-chave FORA do .select() lança (não vira cursor undefined)", async () => {
  // O `.select()` do call-site é uma string; a interface da linha PROMETE `id`. Tirar `id`
  // do select não quebra o typecheck — quebra o cursor, em runtime, sem uma palavra.
  const dados = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
  const build = (cursor: number | null, limite: number) => {
    const janela = dados.filter((l) => cursor === null || l.id > cursor).slice(0, limite)
      .map((l) => ({ ...l, id: undefined as unknown as number })); // select sem a chave
    return Promise.resolve({ data: janela, error: null });
  };
  await assertLanca(
    () => fetchAllKeyset<{ id: number }, number>(build, (l) => l.id, "t"),
    "chave",
  );
});

Deno.test("keyset: página fora de ordem NO MEIO lança (não só extremos trocados)", async () => {
  // Sem `.order()` o PostgREST devolve ordem arbitrária. Comparar só primeira vs última
  // deixa passar a página cujos extremos por acaso estão certos e o miolo não — e aí a
  // "última linha" não é a maior chave, então o cursor pula o resto.
  const dados = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
  const build = (cursor: number | null, limite: number) => {
    const janela = dados.filter((l) => cursor === null || l.id > cursor).slice(0, limite);
    if (janela.length > 3) {
      const t = janela[1];
      janela[1] = janela[janela.length - 2];
      janela[janela.length - 2] = t; // extremos intactos, miolo trocado
    }
    return Promise.resolve({ data: janela, error: null });
  };
  await assertLanca(
    () => fetchAllKeyset<{ id: number }, number>(build, (l) => l.id, "t"),
    "ordem",
  );
});
