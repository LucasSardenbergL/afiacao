// deno test supabase/functions/_shared/leitura-critica_test.ts
import {
  codigoDoErro,
  exigirLeitura,
  exigirLinhas,
  FalhaLeituraCritica,
  tolerarColunaAusente,
  tolerarLeitura,
} from "./leitura-critica.ts";

function assertEq(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}

function assertLanca(fn: () => unknown, msg: string): FalhaLeituraCritica {
  try {
    fn();
  } catch (e) {
    if (e instanceof FalhaLeituraCritica) return e;
    throw new Error(`${msg}: lançou ${(e as Error).name}, esperava FalhaLeituraCritica`);
  }
  throw new Error(`${msg}: NÃO lançou`);
}

// ── O núcleo da classe: os TRÊS estados que o `?? 0` colapsava ───────────────────────

Deno.test("exigirLeitura: ERRO de transporte LANÇA (não vira lista vazia)", () => {
  const e = assertLanca(
    () => exigirLeitura({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }, "fin_contas_correntes"),
    "timeout 57014",
  );
  assertEq(e.fonte, "fin_contas_correntes");
  assertEq(e.codigo, "57014");
});

Deno.test("exigirLeitura: RLS (42501) também LANÇA", () => {
  const e = assertLanca(
    () => exigirLeitura({ data: null, error: { code: "42501", message: "permission denied" } }, "fin_dre_snapshots"),
    "rls 42501",
  );
  assertEq(e.codigo, "42501");
});

Deno.test("exigirLeitura: AUSÊNCIA de linha NÃO lança — devolve null e o caller mantém o fallback", () => {
  // Estado legítimo do negócio (empresa sem balancete). O comportamento atual (0) é
  // PRESERVADO de propósito: o fix separa "não consegui ler" de "não existe", e só o
  // primeiro passou a ser erro.
  assertEq(exigirLeitura<{ valor: number }>({ data: null, error: null }, "fin_estoque_valor"), null);
  assertEq(exigirLeitura<number[]>({ data: [], error: null }, "fin_eventos_recorrentes"), []);
});

Deno.test("exigirLeitura: ZERO de verdade atravessa intacto (não é confundido com falha)", () => {
  const linhas = [{ saldo_atual: 0 }];
  assertEq(exigirLeitura({ data: linhas, error: null }, "fin_contas_correntes"), linhas);
});

Deno.test("exigirLeitura: erro com data PREENCHIDA ainda LANÇA (resposta parcial não é sucesso)", () => {
  assertLanca(
    () => exigirLeitura({ data: [{ saldo_atual: 10 }], error: { code: "57014" } }, "fin_contas_correntes"),
    "erro+data",
  );
});

// ── Degradação honesta (a outra saída) ──────────────────────────────────────────────

Deno.test("tolerarLeitura: erro NÃO lança, mas devolve motivo (deixa de se disfarçar de 'sem linha')", () => {
  const r = tolerarLeitura({ data: null, error: { code: "57014" } }, "v_capital_giro_prazos");
  assertEq(r.dados, null);
  if (!r.motivo) throw new Error("erro sem motivo — a degradação ficaria muda");
  if (!r.motivo.includes("v_capital_giro_prazos")) throw new Error(`motivo não nomeia a fonte: ${r.motivo}`);
  if (!r.motivo.includes("57014")) throw new Error(`motivo não traz o código: ${r.motivo}`);
});

Deno.test("tolerarLeitura: ausência de linha NÃO produz motivo (senão a tela alarmaria no caso legítimo)", () => {
  const r = tolerarLeitura({ data: null, error: null }, "v_capital_giro_prazos");
  assertEq(r.dados, null);
  assertEq(r.motivo, null);
});

// ── PII: a mensagem vai ao CLIENTE pelo catch do serve() ─────────────────────────────

Deno.test("a mensagem da exceção NÃO carrega texto livre do servidor (só fonte + código)", () => {
  // O PostgREST encaminha o MESSAGE do Postgres, que pode interpolar valor de linha.
  const vazamento = "duplicate key value violates unique constraint: CPF 123.456.789-00";
  const e = assertLanca(
    () => exigirLeitura({ data: null, error: { code: "23505", message: vazamento, details: vazamento, hint: vazamento } }, "fin_contas_correntes"),
    "pii",
  );
  if (e.message.includes("123.456.789-00")) {
    throw new Error(`PII vazou na mensagem que vai ao cliente: ${e.message}`);
  }
  // O detalhe cru continua disponível para diagnóstico, mas só em `cause` (não é
  // serializado por String(err.message) no catch da edge).
  assertEq((e.cause as { message?: string })?.message, vazamento);
});

Deno.test("tolerarLeitura: o motivo também é domínio fechado", () => {
  const vazamento = "row (uuid-do-cliente, 4321.55) violates check";
  const r = tolerarLeitura({ data: null, error: { code: "23514", message: vazamento } }, "v_capital_giro_prazos");
  if (r.motivo?.includes("4321.55")) throw new Error(`PII vazou no motivo: ${r.motivo}`);
});

// ── Lista vazia não é fato: nenhuma linha ≠ soma zero ────────────────────────────────

Deno.test("exigirLinhas: lista VAZIA lança (nenhuma conta ≠ caixa zero)", () => {
  const e = assertLanca(
    () => exigirLinhas({ data: [], error: null }, "fin_contas_correntes"),
    "lista vazia",
  );
  assertEq(e.codigo, "SEM_LINHAS");
  assertEq(e.fonte, "fin_contas_correntes");
});

Deno.test("exigirLinhas: data null sem erro também lança", () => {
  const e = assertLanca(
    () => exigirLinhas({ data: null, error: null }, "fin_contas_correntes"),
    "data null",
  );
  assertEq(e.codigo, "SEM_LINHAS");
});

Deno.test("exigirLinhas: ZERO REAL atravessa — linhas existem e somam zero", () => {
  // O caso que NÃO pode mudar de comportamento: conta cadastrada com saldo 0 é um FATO,
  // e continua valendo 0. Sem este assert, "lança quando vazio" poderia virar "lança
  // quando o total é zero", que é outra coisa e quebraria empresa com caixa zerado real.
  const linhas = [{ saldo_atual: 0 }, { saldo_atual: 0 }];
  assertEq(exigirLinhas({ data: linhas, error: null }, "fin_contas_correntes"), linhas);
});

Deno.test("exigirLinhas: saldo NEGATIVO atravessa (colacor/colacor_sc em prod)", () => {
  const linhas = [{ saldo_atual: -411609.09 }];
  assertEq(exigirLinhas({ data: linhas, error: null }, "fin_contas_correntes"), linhas);
});

Deno.test("exigirLinhas: erro de transporte continua lançando com o código do erro", () => {
  const e = assertLanca(
    () => exigirLinhas({ data: null, error: { code: "57014" } }, "fin_contas_correntes"),
    "timeout",
  );
  // Não pode virar SEM_LINHAS: a causa é outra e o diagnóstico mudaria.
  assertEq(e.codigo, "57014");
});

Deno.test("a mensagem de SEM_LINHAS não diz 'falhou' (não houve falha, a leitura voltou vazia)", () => {
  const e = assertLanca(() => exigirLinhas({ data: [], error: null }, "fin_contas_correntes"), "msg");
  if (e.message.includes("falhou")) {
    throw new Error(`mensagem manda caçar um erro que não houve: ${e.message}`);
  }
  if (!e.message.includes("DESCONHECIDO")) {
    throw new Error(`mensagem não diz que o valor é desconhecido: ${e.message}`);
  }
});

// ── Coluna opcional: tolera "não existe", NÃO tolera "o banco piscou" ────────────────

Deno.test("tolerarColunaAusente: coluna inexistente é engolida (feature não migrada)", () => {
  for (const code of ["42703", "42P01", "PGRST204", "PGRST202"]) {
    const r = tolerarColunaAusente({ data: null, error: { code } }, "fin_config_cashflow.folha_categorias_codigos");
    assertEq(r, null, `código ${code} deveria ser tolerado`);
  }
});

Deno.test("tolerarColunaAusente: timeout/RLS LANÇA (não desliga o guard em silêncio)", () => {
  // Sem esta distinção, um erro transitório desligaria o guard de dupla contagem da folha
  // e ninguém saberia — "feature desligada" indistinguível de "leitura falhou".
  for (const code of ["57014", "42501", "PGRST301"]) {
    const e = assertLanca(
      () => tolerarColunaAusente({ data: null, error: { code } }, "fin_config_cashflow.folha_categorias_codigos"),
      `código ${code} deveria LANÇAR`,
    );
    assertEq(e.codigo, code);
  }
});

Deno.test("tolerarColunaAusente: sem erro devolve a linha (coluna existe e tem valor)", () => {
  const linha = { folha_categorias_codigos: ["2.03.01"] };
  assertEq(tolerarColunaAusente({ data: linha, error: null }, "fin_config_cashflow.folha_categorias_codigos"), linha);
});

Deno.test("codigoDoErro: código fora da forma esperada vira 'desconhecido' (allowlist por FORMA)", () => {
  assertEq(codigoDoErro({ code: "57014" }), "57014");
  assertEq(codigoDoErro({ code: "PGRST116" }), "PGRST116");
  // Texto livre disfarçado de código não passa.
  assertEq(codigoDoErro({ code: "erro no cliente João da Silva" }), "desconhecido");
  assertEq(codigoDoErro({ code: null }), "desconhecido");
  assertEq(codigoDoErro(null), "desconhecido");
  assertEq(codigoDoErro(undefined), "desconhecido");
});

// ── O SINK, medido em vez de afirmado (challenge Codex desta entrega) ────────────────
// O cabeçalho deste módulo afirma que "o texto original fica em `cause`, que não é
// serializado pela resposta". Isso era FALSO por um detalhe de JavaScript: `this.cause = x`
// cria uma propriedade PRÓPRIA e ENUMERÁVEL, enquanto `super(msg, { cause: x })` cria uma
// não-enumerável. Com a atribuição, `JSON.stringify(err)` e `{ ...err }` carregam o objeto
// cru do PostgREST inteiro — `message`, `details` e `hint` incluídos, e é neles que o
// Postgres interpola valor de linha. Medido antes de corrigir:
//     Object.keys(err) => ["fonte","codigo","name","cause"]
//     JSON.stringify(err).includes("52998224725") => true
// Nenhum consumidor de hoje serializa o Error inteiro na resposta (todos usam `.message`),
// então isto era munição carregada, não tiro disparado — mas a garantia estava afirmada
// sem o sink verificado, que é exatamente o pecado que esta família de helpers combate.

const CRU_PII = {
  message: "CPF 52998224725 invalido",
  details: "row id=9",
  hint: "segredo",
  code: "57014",
};

Deno.test("cause NÃO é enumerável: JSON.stringify do erro não carrega o cru do PostgREST", () => {
  const e = new FalhaLeituraCritica("fonte_x", CRU_PII);
  const serializado = JSON.stringify(e);
  for (const vazamento of ["52998224725", "row id=9", "segredo", "CPF"]) {
    if (serializado.includes(vazamento)) {
      throw new Error(`JSON.stringify(err) vazou ${JSON.stringify(vazamento)}: ${serializado}`);
    }
  }
  assertEq(Object.keys(e).includes("cause"), false, "cause voltou a ser enumerável");
});

Deno.test("cause NÃO é enumerável: o spread `{...err}` não copia o cru", () => {
  const e = new FalhaLeituraCritica("fonte_x", CRU_PII);
  const copia = { ...e } as Record<string, unknown>;
  assertEq("cause" in copia, false, "o spread copiou cause — um `{...err}` num handler vaza");
  if (JSON.stringify(copia).includes("52998224725")) {
    throw new Error(`spread vazou PII: ${JSON.stringify(copia)}`);
  }
});

Deno.test("cause continua ACESSÍVEL: não-enumerável não é apagado (o log da edge precisa dele)", () => {
  const e = new FalhaLeituraCritica("fonte_x", CRU_PII);
  assertEq((e.cause as { message?: string } | undefined)?.message, CRU_PII.message);
});

// ── O código "sanitizado" aceitava PII ──────────────────────────────────────────────
// `FORMA_CODIGO = /^[A-Za-z0-9_]{1,12}$/` valida FORMA, não domínio: um CPF sem pontuação
// tem 11 dígitos e passava INTEIRO para a mensagem pública, pela porta que existe para
// fechá-la. O domínio real é pequeno e conhecido: SQLSTATE (5 chars) + PGRSTnnn + os dois
// códigos INTERNOS desta família.

Deno.test("codigo: um CPF no campo `code` NÃO passa por sanitizado", () => {
  assertEq(codigoDoErro({ code: "52998224725" }), "desconhecido");
  const e = new FalhaLeituraCritica("fonte_x", { code: "52998224725" });
  if (e.message.includes("52998224725")) {
    throw new Error(`PII pelo campo code chegou a mensagem publica: ${e.message}`);
  }
});

Deno.test("codigo: o domínio LEGÍTIMO continua passando inteiro", () => {
  for (const c of ["57014", "42501", "42703", "42P01", "PGRST204", "PGRST202"]) {
    assertEq(codigoDoErro({ code: c }), c, `o código real ${c} foi descartado`);
  }
  for (const c of ["MALFORMADA", "SEM_LINHAS"]) {
    assertEq(codigoDoErro({ code: c }), c, `o código interno ${c} foi descartado`);
  }
});
