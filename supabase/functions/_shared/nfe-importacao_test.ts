// Testa a interpretação do retorno/erro da RPC `importar_nfe_recebimento` e a triagem do cabeçalho
// (nfe-importacao.ts) no runtime real (Deno), com cliente falso — `deno test --no-remote`.
import {
  classificarErro,
  erroDeLote,
  importarViaRpc,
  interpretarResultadoRpc,
  registrarFalhaImportacao,
  registravel,
  type RespostaRpc,
  triarCabecalho,
  validarLote,
} from "./nfe-importacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const ID = "6f4b0a2e-0000-4000-8000-000000000001";
const CHAVE = "35261012345678000190550010000000011000000011";
const ITEM = { sequencia: 1, descricao: "Item", unidade_nfe: "UN", quantidade_nfe: 2 };
const ENTRADA = { cabecalho: { chave_acesso: CHAVE }, itens: [ITEM], origem: "webhook" as const };

function cliente(respostas: Record<string, RespostaRpc | Error>) {
  const chamadas: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    chamadas,
    rpc(fn: string, args: Record<string, unknown>) {
      chamadas.push({ fn, args });
      const r = respostas[fn];
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r ?? { data: null, error: { message: `sem resposta falsa para ${fn}` } });
    },
  };
}

Deno.test("interpretar: os 5 desfechos da RPC, com os campos que cada um carrega", () => {
  assertEquals(interpretarResultadoRpc({ resultado: "importada", id: ID, itens: 3 }), { tipo: "importada", id: ID, itens: 3 });
  assertEquals(interpretarResultadoRpc({ resultado: "reparada", id: ID, itens: 2 }), { tipo: "reparada", id: ID, itens: 2 });
  assertEquals(interpretarResultadoRpc({ resultado: "ja_importada", id: ID, itens: 3 }), { tipo: "ja_importada", id: ID, itens: 3 });
  assertEquals(
    interpretarResultadoRpc({ resultado: "bloqueada", id: ID, itens: 0, motivo: "status efetivado" }),
    { tipo: "bloqueada", id: ID, itens: 0, motivo: "status efetivado" },
  );
  assertEquals(
    interpretarResultadoRpc({ resultado: "divergente", id: ID, itens: 3, esperados: 2, motivo: "cardinalidade" }),
    { tipo: "divergente", id: ID, itens: 3, esperados: 2, motivo: "cardinalidade" },
  );
});

Deno.test("interpretar é fail-closed: forma inesperada, resultado desconhecido, itens ilegível → erro, nunca sucesso", () => {
  const casos: unknown[] = [
    null,
    [],
    "importada",
    { resultado: "importada" }, // sem id/itens
    { resultado: "importada", id: ID, itens: "3" }, // contagem em string
    { resultado: "importada", id: ID, itens: -1 },
    { resultado: "importada", id: ID, itens: 1.5 },
    { resultado: "sucesso", id: ID, itens: 1 }, // vocabulário fora da RPC
    { resultado: "divergente", id: ID, itens: 3 }, // divergente sem esperados
  ];
  for (const c of casos) {
    const r = interpretarResultadoRpc(c);
    if (r.tipo !== "erro" || r.classe !== "infra") throw new Error(`devia ser erro infra: ${JSON.stringify(c)} → ${JSON.stringify(r)}`);
  }
});

Deno.test("classificar: NFE0x e tipos que não cabem são DADO; PGRST202/42883 é RPC AUSENTE; o resto é infra", () => {
  assertEquals(["NFE01", "NFE02", "NFE03", "22001", "23502", "23514", "22P02", "22P05"].map((c) => classificarErro(c, "x")), Array(8).fill("dado"));
  assertEquals(classificarErro("PGRST202", "Could not find the function"), "rpc_ausente");
  assertEquals(classificarErro("42883", "function does not exist"), "rpc_ausente");
  assertEquals(classificarErro(null, "Could not find the function public.importar_nfe_recebimento"), "rpc_ausente");
  assertEquals(["23505", "40001", "57014", "08006", null].map((c) => classificarErro(c, "falha")), Array(5).fill("infra"));
});

Deno.test("importarViaRpc: passa o payload com os nomes dos parâmetros da RPC e devolve o desfecho", async () => {
  const c = cliente({ importar_nfe_recebimento: { data: { resultado: "importada", id: ID, itens: 1 }, error: null } });
  assertEquals(await importarViaRpc(c, ENTRADA), { tipo: "importada", id: ID, itens: 1 });
  assertEquals(c.chamadas, [{
    fn: "importar_nfe_recebimento",
    args: { p_cabecalho: { chave_acesso: CHAVE }, p_itens: [ITEM], p_origem: "webhook" },
  }]);
});

Deno.test("importarViaRpc: erro do PostgREST vira erro classificado; transporte que explode vira infra (nunca lança)", async () => {
  const dado = await importarViaRpc(cliente({ importar_nfe_recebimento: { data: null, error: { message: "sequencia repetida", code: "NFE02" } } }), ENTRADA);
  assertEquals(dado, { tipo: "erro", classe: "dado", code: "NFE02", mensagem: "sequencia repetida" });
  const ausente = await importarViaRpc(cliente({ importar_nfe_recebimento: { data: null, error: { message: "Could not find the function", code: "PGRST202" } } }), ENTRADA);
  assertEquals(ausente.tipo === "erro" && ausente.classe, "rpc_ausente");
  const rede = await importarViaRpc(cliente({ importar_nfe_recebimento: new Error("fetch failed") }), ENTRADA);
  assertEquals(rede, { tipo: "erro", classe: "infra", code: null, mensagem: "fetch failed" });
});

Deno.test("validarLote: pega o que o mapper fabrica por default (quantidade 0, não-objeto, descrição vazia) e aceita o lote são", () => {
  assertEquals(validarLote([ITEM, { ...ITEM, sequencia: "2" }, { ...ITEM, sequencia: 3, quantidade_nfe: "10.0000" }]), null);
  assertEquals(validarLote(7), "itens não é uma lista");
  assertEquals(validarLote([]), "lote sem itens");
  assertEquals(validarLote([ITEM, 7]), "item #2: não é um objeto");
  assertEquals(validarLote([null]), "item #1: não é um objeto");
  assertEquals(validarLote([{ ...ITEM, quantidade_nfe: 0 }]), "item #1: quantidade_nfe inválida (0)");
  assertEquals(validarLote([{ ...ITEM, quantidade_nfe: -1 }]), "item #1: quantidade_nfe inválida (-1)");
  assertEquals(validarLote([{ ...ITEM, quantidade_nfe: "abc" }]), "item #1: quantidade_nfe inválida (abc)");
  assertEquals(validarLote([{ ...ITEM, sequencia: 0 }]), "item #1: sequencia inválida (0)");
  assertEquals(validarLote([{ ...ITEM, sequencia: 1.5 }]), "item #1: sequencia inválida (1.5)");
  assertEquals(validarLote([{ ...ITEM, descricao: "  " }]), "item #1: descricao vazia");
  assertEquals(validarLote([{ ...ITEM, unidade_nfe: "" }]), "item #1: unidade_nfe vazia");
  assertEquals(erroDeLote("x"), { tipo: "erro", classe: "dado", code: "NFE01", mensagem: "lote inválido: x" });
});

Deno.test("importarViaRpc: lote inválido NÃO chega ao banco — erro de dado (NFE01) sem chamada à RPC", async () => {
  const c = cliente({ importar_nfe_recebimento: { data: { resultado: "importada", id: ID, itens: 1 }, error: null } });
  const r = await importarViaRpc(c, { ...ENTRADA, itens: [{ ...ITEM, quantidade_nfe: 0 }] });
  assertEquals(r, { tipo: "erro", classe: "dado", code: "NFE01", mensagem: "lote inválido: item #1: quantidade_nfe inválida (0)" });
  assertEquals(c.chamadas.length, 0);
});

Deno.test("registravel: erro de dado, bloqueada e divergente vão ao ledger; sucesso, infra e rpc_ausente não", () => {
  assertEquals(registravel({ tipo: "erro", classe: "dado", code: "22001", mensagem: "too long" }), { code: "22001", mensagem: "too long" });
  assertEquals(registravel({ tipo: "bloqueada", id: ID, itens: 0, motivo: "status efetivado" }), { code: "BLOQUEADA", mensagem: "status efetivado" });
  assertEquals(
    registravel({ tipo: "divergente", id: ID, itens: 3, esperados: 2, motivo: "cardinalidade" }),
    { code: "DIVERGENTE", mensagem: "cardinalidade: 3 gravados, 2 no payload" },
  );
  assertEquals(registravel({ tipo: "importada", id: ID, itens: 1 }), null);
  assertEquals(registravel({ tipo: "ja_importada", id: ID, itens: 1 }), null);
  assertEquals(registravel({ tipo: "erro", classe: "infra", code: "57014", mensagem: "x" }), null);
  assertEquals(registravel({ tipo: "erro", classe: "rpc_ausente", code: "PGRST202", mensagem: "x" }), null);
});

Deno.test("registrarFalha: devolve as tentativas; ledger que falha é null; ledger PENDURADO é null no deadline (não segura a resposta)", async () => {
  const ok = cliente({ nfe_importacao_falha_registrar: { data: 2, error: null } });
  assertEquals(await registrarFalhaImportacao(ok, { chaveAcesso: CHAVE, origem: "sync", code: "22001", mensagem: "value too long", warehouseId: "wh", omieIdReceb: 77 }), 2);
  assertEquals(ok.chamadas[0].args, {
    p_chave_acesso: CHAVE, p_origem: "sync", p_sqlstate: "22001", p_erro: "value too long", p_warehouse_id: "wh", p_omie_id_receb: 77,
  });
  const quebrado = cliente({ nfe_importacao_falha_registrar: { data: null, error: { message: "permission denied" } } });
  assertEquals(await registrarFalhaImportacao(quebrado, { chaveAcesso: CHAVE, origem: "sync", code: "22001", mensagem: "x" }), null);
  const pendurado = { rpc: () => new Promise<RespostaRpc>(() => {}) };
  const t0 = Date.now();
  assertEquals(await registrarFalhaImportacao(pendurado, { chaveAcesso: CHAVE, origem: "webhook", code: "NFE02", mensagem: "x" }, 50), null);
  if (Date.now() - t0 > 2_000) throw new Error("o deadline não cortou a espera");
});

const linha = (extra: Record<string, unknown>) => ({
  id: ID, omie_id_receb: 1, chave_acesso: CHAVE, status: "pendente",
  conferente_id: null, conferido_at: null, efetivado_at: null, efetivacao_lock_at: null,
  nfe_recebimento_itens: [{ count: 0 }], ...extra,
});

Deno.test("triar: com itens = completo; pendente sem itens e sem sinais = reparável", () => {
  assertEquals(triarCabecalho(linha({ nfe_recebimento_itens: [{ count: 3 }] })), { tipo: "completo", itens: 3 });
  assertEquals(triarCabecalho(linha({})), { tipo: "reparavel" });
});

Deno.test("triar: status não-pendente ou QUALQUER sinal de uso = completo (não reparável); sinal AUSENTE conta como em uso", () => {
  assertEquals(triarCabecalho(linha({ status: "efetivado" })), { tipo: "completo", itens: 0 });
  assertEquals(triarCabecalho(linha({ efetivacao_lock_at: "2026-10-18T00:00:00Z" })), { tipo: "completo", itens: 0 });
  assertEquals(triarCabecalho(linha({ conferente_id: "u1" })), { tipo: "completo", itens: 0 });
  const sem = linha({}) as Record<string, unknown>;
  delete sem.conferido_at;
  assertEquals(triarCabecalho(sem), { tipo: "completo", itens: 0 });
});

Deno.test("triar: contagem ilegível é ERRO, nunca zero", () => {
  for (const c of [undefined, [], [{}], [{ count: "0" }], [{ count: null }], [{ count: -1 }]]) {
    const r = triarCabecalho(linha({ nfe_recebimento_itens: c }));
    if (r.tipo !== "erro") throw new Error(`devia ser erro: ${JSON.stringify(c)} → ${JSON.stringify(r)}`);
  }
  assertEquals(triarCabecalho(null).tipo, "erro");
});
