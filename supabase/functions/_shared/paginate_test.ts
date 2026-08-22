// Testa o CÓDIGO REAL de `fetchAll` (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/paginate_test.ts
import { fetchAll, fetchAllKeyset } from "./paginate.ts";
import { FalhaLeituraCritica } from "./leitura-critica.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Exige rejeição E a CLASSE. Um try/catch que só checasse "rejeitou" seria teatro: passaria
// com um TypeError de código quebrado e deixaria de provar QUAL guard disparou.
async function capturarFalha(fn: () => Promise<unknown>): Promise<FalhaLeituraCritica> {
  let capturado: unknown;
  let rejeitou = false;
  try {
    await fn();
  } catch (e) {
    rejeitou = true;
    capturado = e;
  }
  if (!rejeitou) throw new Error("esperava rejeição, mas a promise RESOLVEU");
  if (!(capturado instanceof FalhaLeituraCritica)) {
    const nome = capturado === null
      ? "null"
      : typeof capturado === "object"
      ? (capturado as Error).constructor?.name
      : typeof capturado;
    throw new Error(`esperava FalhaLeituraCritica, veio ${nome}: ${(capturado as Error)?.message}`);
  }
  return capturado;
}

// "Banco" fake de N linhas; o build() pagina por .range() como o PostgREST faria,
// mas SEM o cap de 1000 (assim provamos que fetchAll busca a cauda inteira).
function fakeTable(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  let calls = 0;
  const build = (from: number, to: number) => {
    calls++;
    return Promise.resolve({ data: all.slice(from, to + 1), error: null });
  };
  return { build, calls: () => calls };
}

Deno.test("abaixo do cap: retorna tudo em 1 request (estado real hoje: 292 linhas)", async () => {
  const t = fakeTable(292);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 292);
  assertEquals(t.calls(), 1);
});

Deno.test("ACIMA do cap (o bug): retorna a cauda inteira, não trunca em 1000", async () => {
  const t = fakeTable(2300);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 2300); // sem paginação, o PostgREST devolveria só 1000
  assertEquals((rows[2299] as { id: number }).id, 2299);
  assertEquals(t.calls(), 3); // 1000 + 1000 + 300
});

Deno.test("exatamente no cap: 1 request extra vazio, sem perder nem duplicar", async () => {
  const t = fakeTable(1000);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 1000);
  assertEquals(t.calls(), 2); // 2ª página volta vazia → para
});

Deno.test("dois caps cheios + resto: 2001 linhas em 3 requests", async () => {
  const t = fakeTable(2001);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 2001);
  assertEquals(t.calls(), 3);
});

Deno.test("tabela vazia: 1 request, zero linhas", async () => {
  const t = fakeTable(0);
  const rows = await fetchAll<{ id: number }>(t.build, "t");
  assertEquals(rows.length, 0);
  assertEquals(t.calls(), 1);
});

// ── PII: o texto do servidor não pode sair da edge ──────────────────────────────────────
// `error.message` do PostgREST encaminha o MESSAGE do Postgres, que pode interpolar valor de
// LINHA (`RAISE EXCEPTION` com ID/CPF; erro de cast reproduzindo o valor inválido). O `catch`
// do `Deno.serve` das edges devolve `String(err.message)` no CORPO da resposta HTTP — então
// esse texto SAI DA EDGE. `fetchAll` lança em DOMÍNIO FECHADO: fonte (constante do código) +
// código sanitizado por allowlist de FORMA. O cru sobrevive em `cause`, que a resposta não
// serializa e que fica só nos logs. Mesmo contrato da irmã single-shot (`leitura-critica.ts`).

Deno.test("erro na página: lança FalhaLeituraCritica e NÃO vaza o texto do servidor", async () => {
  const erro = await capturarFalha(() =>
    fetchAll(
      (_f, _t) =>
        Promise.resolve({
          data: null,
          error: { message: "boom cpf 52998224725 invalido", code: "57014" },
        }),
      "minha_tabela",
    )
  );
  assertEquals(erro.fonte, "minha_tabela", "a fonte se perdeu no envelope");
  assertEquals(erro.codigo, "57014", "o code do PostgREST se perdeu no envelope");
  if (!erro.message.includes("minha_tabela")) {
    throw new Error(`a fonte não chegou à mensagem: ${erro.message}`);
  }
  if (!erro.message.includes("57014")) {
    throw new Error(`o code não chegou à mensagem: ${erro.message}`);
  }
  if (erro.message.includes("boom")) {
    throw new Error(`texto do servidor vazou na mensagem publica: ${erro.message}`);
  }
  if (erro.message.includes("52998224725")) {
    throw new Error(`valor de linha (PII) vazou na mensagem publica: ${erro.message}`);
  }
  // O cru não some: fica em `cause`, para os logs da edge.
  assertEquals(
    (erro.cause as { message?: string } | undefined)?.message,
    "boom cpf 52998224725 invalido",
    "o detalhe cru sumiu de cause — os logs da edge perderam o diagnóstico",
  );
});

Deno.test("erro sem code: o codigo degrada para 'desconhecido', a mensagem segue fechada", async () => {
  const erro = await capturarFalha(() =>
    fetchAll(
      (_f, _t) => Promise.resolve({ data: null, error: { message: "detalhe cru do servidor" } }),
      "outra_tabela",
    )
  );
  assertEquals(erro.codigo, "desconhecido");
  if (erro.message.includes("detalhe cru")) {
    throw new Error(`texto do servidor vazou na mensagem publica: ${erro.message}`);
  }
});

Deno.test("erro na 2a pagina: o envelope fecha a cauda também, não só a 1a leitura", async () => {
  // O laço tem N páginas e só a PRIMEIRA passa pelo caminho feliz. Um envelope aplicado só
  // fora do laço deixaria a página 2+ vazar — este é o eixo que o teste de 1 página não vê.
  const p0 = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  const erro = await capturarFalha(() =>
    fetchAll<{ id: number }>(
      (from, _to) =>
        Promise.resolve(
          from === 0
            ? { data: p0, error: null }
            : { data: null, error: { message: "boom na cauda", code: "42501" } },
        ),
      "t_cauda",
    )
  );
  assertEquals(erro.codigo, "42501");
  if (erro.message.includes("boom")) {
    throw new Error(`texto do servidor vazou na pagina 2: ${erro.message}`);
  }
});

Deno.test("data null SEM error: LANÇA MALFORMADA — resposta malformada não é fim da tabela", async () => {
  // O `?? []` convertia `{data:null, error:null}` em página vazia → EOF falso → o acumulado
  // PARCIAL voltava como se fosse a tabela inteira. Mesmo contrato do fetchAllPages
  // (src/lib/postgrest.ts) e do buscarTodasPaginas pós-#1564: só `data: []` encerra.
  // O código `MALFORMADA` é o mesmo que `exigirLista` nomeia para a leitura de uma página só.
  const erro = await capturarFalha(() =>
    fetchAll((_f, _t) => Promise.resolve({ data: null, error: null }), "minha_tabela")
  );
  assertEquals(erro.codigo, "MALFORMADA");
  assertEquals(erro.fonte, "minha_tabela");
});

Deno.test("data null SEM error no MEIO: lança e NÃO devolve o acumulado parcial", async () => {
  // Página 0 cheia + página 1 malformada: o bug antigo devolveria as 1000 primeiras como
  // se fossem a tabela inteira — numericamente indistinguível de uma tabela de 1000.
  const p0 = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  const erro = await capturarFalha(() =>
    fetchAll<{ id: number }>(
      (from, _to) =>
        Promise.resolve(from === 0 ? { data: p0, error: null } : { data: null, error: null }),
      "t_parcial",
    )
  );
  assertEquals(erro.codigo, "MALFORMADA");
});

// ── Os dois furos que sobravam ao redor do envelope (challenge Codex desta entrega) ──

Deno.test("build que REJEITA (não resolve com {error}): a rejeição crua não escapa", async () => {
  // O `await build(...)` tem DOIS desfechos de falha e o envelope só cobria um. Uma rejeição
  // — fetch derrubado, `.throwOnError()` de um caller futuro, erro de programação no callback
  // — passava direto por `fetchAll` e chegava ao `catch` do `Deno.serve` como `Error` crua,
  // pelo caminho que devolve `.message` no corpo. O wrapper `paginarFonte` que este PR removeu
  // cobria isto com um try/catch; a cobertura tinha de ir para o helper junto, e não foi.
  const erro = await capturarFalha(() =>
    fetchAll(() => Promise.reject(new Error("CPF-RAW-52998224725")), "t_rejeita")
  );
  assertEquals(erro.codigo, "REJEITADA");
  assertEquals(erro.fonte, "t_rejeita");
  if (erro.message.includes("52998224725")) {
    throw new Error(`a rejeicao crua vazou na mensagem publica: ${erro.message}`);
  }
  assertEquals(
    (erro.cause as { message?: string } | undefined)?.message,
    "CPF-RAW-52998224725",
    "o motivo da rejeicao sumiu de cause — os logs da edge perderam o diagnostico",
  );
});

Deno.test("uma FalhaLeituraCritica que sobe de dentro do build não é re-envelopada", async () => {
  // Sem esta guarda o envelope de rejeição empacotaria a falha JÁ fechada de um caller que
  // valida a página por conta própria, trocando o `code` real (57014) por `REJEITADA`.
  const dentro = new FalhaLeituraCritica("fonte_interna", { code: "57014" });
  const erro = await capturarFalha(() => fetchAll(() => Promise.reject(dentro), "t_fora"));
  assertEquals(erro.codigo, "57014", "o code original virou REJEITADA no re-envelope");
  assertEquals(erro.fonte, "fonte_interna");
});

Deno.test("data que não é ARRAY: LANÇA — `data == null` não bastava", async () => {
  // `out.push(...rows)` com uma string ESPALHA os caracteres: `{data:"CPF"}` resolvia
  // `["C","P","F"]` — três "linhas" que o call-site trata como dados do banco. Pior que um
  // erro: é PII picada em caracteres entrando no cálculo como se fosse leitura legítima.
  const erro = await capturarFalha(() =>
    fetchAll((_f, _t) => Promise.resolve({ data: "CPF" as unknown as string[], error: null }), "t_texto")
  );
  assertEquals(erro.codigo, "MALFORMADA");
});

Deno.test("data:{} (objeto, não array) também LANÇA — a forma é que decide", async () => {
  const erro = await capturarFalha(() =>
    fetchAll((_f, _t) => Promise.resolve({ data: {} as unknown as string[], error: null }), "t_objeto")
  );
  assertEquals(erro.codigo, "MALFORMADA");
});

// ── O helper IRMÃO (keyset) nasceu com o mesmo vazamento ─────────────────────────────
// `fetchAllKeyset` entrou no mesmo módulo em PR paralelo (#1856) e repetiu
// ``new Error(`${label}: ${error.message}`)`` — o defeito voltaria por uma porta recém-aberta.
// Os testes abaixo são os mesmos eixos do `fetchAll`, porque o SINK é o mesmo: o `catch` do
// `Deno.serve` devolve `.message` no corpo da resposta HTTP.
//
// As violações de CONTRATO do keyset (chave ausente, página fora de ordem, cursor parado) são
// erro de PROGRAMAÇÃO do call-site, não falha de transporte — mas interpolavam o VALOR da chave
// na mensagem, e a chave é uma coluna da linha. O valor vai para `cause`; a mensagem pública
// nomeia só o modo da violação.

function paginaKeyset(n: number, de = 0) {
  return Array.from({ length: n }, (_, i) => ({ id: String(de + i).padStart(6, "0") }));
}

Deno.test("keyset — erro na página: FalhaLeituraCritica com o code, sem o texto do servidor", async () => {
  const erro = await capturarFalha(() =>
    fetchAllKeyset<{ id: string }, string>(
      () =>
        Promise.resolve({
          data: null,
          error: { message: "boom cpf 52998224725", code: "42501" },
        }),
      (l) => l.id,
      "k_fonte",
    )
  );
  assertEquals(erro.codigo, "42501", "o code do PostgREST se perdeu no envelope do keyset");
  assertEquals(erro.fonte, "k_fonte");
  if (erro.message.includes("52998224725")) {
    throw new Error(`PII vazou na mensagem publica do keyset: ${erro.message}`);
  }
  assertEquals((erro.cause as { message?: string } | undefined)?.message, "boom cpf 52998224725");
});

Deno.test("keyset — data não-array: MALFORMADA, não fim da tabela", async () => {
  const erro = await capturarFalha(() =>
    fetchAllKeyset<{ id: string }, string>(
      () => Promise.resolve({ data: "CPF" as unknown as { id: string }[], error: null }),
      (l) => l.id,
      "k_texto",
    )
  );
  assertEquals(erro.codigo, "MALFORMADA");
});

Deno.test("keyset — build que REJEITA: a rejeição crua não escapa", async () => {
  const erro = await capturarFalha(() =>
    fetchAllKeyset<{ id: string }, string>(
      () => Promise.reject(new Error("CPF-RAW-52998224725")),
      (l) => l.id,
      "k_rejeita",
    )
  );
  assertEquals(erro.codigo, "REJEITADA");
  if (erro.message.includes("52998224725")) {
    throw new Error(`a rejeicao crua vazou no keyset: ${erro.message}`);
  }
});

Deno.test("keyset — violação de contrato: o VALOR da chave não vai à mensagem pública", async () => {
  // Cursor parado (chave repetida): a mensagem citava `JSON.stringify(proximo)`, e a chave é
  // uma coluna da linha. O modo da violação é domínio fechado; o valor é dado.
  const repetida = [{ id: "AAA" }, { id: "AAA" }];
  const erro = await capturarFalha(() =>
    fetchAllKeyset<{ id: string }, string>(
      () => Promise.resolve({ data: repetida, error: null }),
      (l) => l.id,
      "k_parado",
    )
  );
  assertEquals(erro.codigo, "KEYSET_CHAVE_REPETIDA");
  if (erro.message.includes("AAA")) {
    throw new Error(`o valor da chave vazou na mensagem publica: ${erro.message}`);
  }
});

Deno.test("keyset — o caminho FELIZ continua igual: pagina a cauda inteira em ordem", async () => {
  // Guarda de não-regressão: o envelope não pode ter mudado a mecânica do cursor.
  let chamadas = 0;
  const linhas = await fetchAllKeyset<{ id: string }, string>(
    (cursor) => {
      chamadas++;
      const de = cursor === null ? 0 : Number(cursor) + 1;
      return Promise.resolve({ data: paginaKeyset(Math.min(1000, 2300 - de), de), error: null });
    },
    (l) => l.id,
    "k_feliz",
  );
  assertEquals(linhas.length, 2300);
  assertEquals(chamadas, 3);
});
