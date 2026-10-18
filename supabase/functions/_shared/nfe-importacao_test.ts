// Testa a interpretação do retorno/erro da RPC `importar_nfe_recebimento` e a triagem do cabeçalho
// (nfe-importacao.ts) no runtime real (Deno), com cliente falso — `deno test --no-remote`.
import {
  classificarErro,
  importarViaRpc,
  interpretarResultadoRpc,
  registrarFalhaImportacao,
  type RespostaRpc,
  triarCabecalho,
} from "./nfe-importacao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const ID = "6f4b0a2e-0000-4000-8000-000000000001";
const CHAVE = "35261012345678000190550010000000011000000011";
const ENTRADA = { cabecalho: { chave_acesso: CHAVE }, itens: [{ sequencia: 1 }], origem: "webhook" as const };

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
  assertEquals(["NFE01", "NFE02", "NFE03", "22001", "23502", "23514", "22P02"].map((c) => classificarErro(c, "x")), Array(7).fill("dado"));
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
    args: { p_cabecalho: { chave_acesso: CHAVE }, p_itens: [{ sequencia: 1 }], p_origem: "webhook" },
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

Deno.test("registrarFalha: só classe DADO registra (rpc_ausente e infra não); devolve as tentativas; ledger que falha é null", async () => {
  const ok = cliente({ nfe_importacao_falha_registrar: { data: 2, error: null } });
  const dado = { tipo: "erro" as const, classe: "dado" as const, code: "22001", mensagem: "value too long" };
  assertEquals(await registrarFalhaImportacao(ok, { chaveAcesso: CHAVE, origem: "sync", erro: dado, warehouseId: "wh", omieIdReceb: 77 }), 2);
  assertEquals(ok.chamadas[0].args, {
    p_chave_acesso: CHAVE, p_origem: "sync", p_sqlstate: "22001", p_erro: "value too long", p_warehouse_id: "wh", p_omie_id_receb: 77,
  });
  const nao = cliente({});
  assertEquals(await registrarFalhaImportacao(nao, { chaveAcesso: CHAVE, origem: "sync", erro: { ...dado, classe: "infra" } }), null);
  assertEquals(await registrarFalhaImportacao(nao, { chaveAcesso: CHAVE, origem: "sync", erro: { ...dado, classe: "rpc_ausente" } }), null);
  assertEquals(nao.chamadas.length, 0, "infra/rpc_ausente não tocam o ledger");
  const quebrado = cliente({ nfe_importacao_falha_registrar: { data: null, error: { message: "permission denied" } } });
  assertEquals(await registrarFalhaImportacao(quebrado, { chaveAcesso: CHAVE, origem: "sync", erro: dado }), null);
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
