// Testa o CÓDIGO REAL de sondas.ts no runtime real (Deno), sem import remoto (test:edges roda
// com --no-remote). Roda com: deno test supabase/functions/omie-sonda-recebimento/sondas_test.ts
//
// O que estas funções sustentam: a sonda EXISTE para descobrir o contrato do Omie, não para
// confirmar um contrato assumido ("nome de endpoint não é contrato" — Codex, spec 2026-08-13).
// Por isso todo o núcleo puro é agnóstico à forma do payload: inventaria caminhos de chave,
// localiza a lista de itens onde quer que ela esteja, e classifica um método inexistente como
// RESULTADO (fault), não como crash.

import {
  caminhosDeChave,
  classificarResposta,
  diffCaminhos,
  ehMetodoDeLeitura,
  localizarItens,
  normalizarItemPO,
  redigirSegredos,
} from "./sondas.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// classificarResposta — um método que não existe é DADO, não exceção
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("classificarResposta: 200 com JSON limpo → ok", () => {
  const d = classificarResposta(200, '{"cabecalho":{"nCodPed":123}}');
  assertEquals(d.tipo, "ok");
  if (d.tipo === "ok") assertEquals(d.json, { cabecalho: { nCodPed: 123 } });
});

Deno.test("classificarResposta: faultstring SEM faultcode também é fault", () => {
  // Lição do repo (omie-sync-estoque): passar adiante virava 'página vazia' → zeros no pendente.
  const d = classificarResposta(200, '{"faultstring":"Metodo nao encontrado"}');
  assertEquals(d.tipo, "fault");
  if (d.tipo === "fault") {
    assertEquals(d.faultcode, null);
    assertEquals(d.faultstring, "Metodo nao encontrado");
  }
});

Deno.test("classificarResposta: HTTP 500 com faultstring é fault (não http_erro)", () => {
  // O Omie sinaliza erro de negócio com HTTP 500 + faultstring (ex.: fim de paginação, 5113).
  const d = classificarResposta(
    500,
    '{"faultcode":"SOAP-ENV:Client-5113","faultstring":"Nao existem registros"}',
  );
  assertEquals(d.tipo, "fault");
  if (d.tipo === "fault") assertEquals(d.faultcode, "SOAP-ENV:Client-5113");
});

Deno.test("classificarResposta: corpo não-JSON NUNCA colapsa em vazio", () => {
  // Classe #1581: trocar 'não consegui ler' por 'não existe' fabrica ausência.
  const d = classificarResposta(200, "<html>gateway timeout</html>");
  assertEquals(d.tipo, "nao_json");
});

Deno.test("classificarResposta: JSON válido que não é objeto é nao_json (fail-closed)", () => {
  // Array no topo impede ler faultstring — tratar como 'não consegui ler', não como sucesso.
  assertEquals(classificarResposta(200, "[1,2,3]").tipo, "nao_json");
  assertEquals(classificarResposta(200, "null").tipo, "nao_json");
});

Deno.test("classificarResposta: HTTP 500 com JSON sem fault → http_erro", () => {
  const d = classificarResposta(500, '{"mensagem":"erro interno"}');
  assertEquals(d.tipo, "http_erro");
  if (d.tipo === "http_erro") assertEquals(d.status, 500);
});

// ─────────────────────────────────────────────────────────────────────────────
// caminhosDeChave — o inventário que responde "o detalhe expõe o que a listagem esconde?"
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("caminhosDeChave: objeto aninhado vira caminho pontuado", () => {
  assertEquals(caminhosDeChave({ a: { b: 1, c: "x" } }), ["a.b", "a.c"]);
});

Deno.test("caminhosDeChave: array COLAPSA em [] e une as chaves dos elementos", () => {
  // União (não o 1º elemento): campo presente só em alguns itens não pode sumir do inventário.
  assertEquals(
    caminhosDeChave({ itens: [{ d: 1 }, { e: 2 }] }),
    ["itens[].d", "itens[].e"],
  );
});

Deno.test("caminhosDeChave: array vazio e null registram o caminho (chave existe)", () => {
  // 'Existe e está vazio' ≠ 'não existe' — a diferença é o achado da sonda.
  assertEquals(caminhosDeChave({ itens: [], obs: null }), ["itens[]", "obs"]);
});

Deno.test("caminhosDeChave: respeita profundidade máxima", () => {
  const fundo = { a: { b: { c: { d: 1 } } } };
  assertEquals(caminhosDeChave(fundo, { profundidadeMax: 2 }), ["a.b"]);
});

Deno.test("caminhosDeChave: ordena e deduplica", () => {
  assertEquals(caminhosDeChave({ b: 1, a: 2, l: [{ x: 1 }, { x: 2 }] }), ["a", "b", "l[].x"]);
});

Deno.test("diffCaminhos: separa exclusivos de comuns", () => {
  assertEquals(diffCaminhos(["a", "b"], ["b", "c"]), {
    soEmA: ["a"],
    soEmB: ["c"],
    comuns: ["b"],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// localizarItens — acha a lista de itens SEM assumir o nome do campo
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("localizarItens: acha produtos_consulta no topo", () => {
  const r = localizarItens({ produtos_consulta: [{ nCodProd: 7, nQtde: 2 }] });
  assertEquals(r?.caminho, "produtos_consulta");
  assertEquals(r?.itens.length, 1);
});

Deno.test("localizarItens: acha itens sob nome DESCONHECIDO (o contrato pode divergir)", () => {
  const r = localizarItens({ envelope: { lista_qualquer: [{ nCodProd: 9, nQtde: 1 }] } });
  assertEquals(r?.caminho, "envelope.lista_qualquer");
});

Deno.test("localizarItens: ignora arrays que não são de item de compra", () => {
  const r = localizarItens({ parcelas: [{ nParcela: 1, nValor: 10 }] });
  assertEquals(r, null);
});

Deno.test("localizarItens: prefere a lista MAIOR quando há mais de uma candidata", () => {
  const r = localizarItens({
    a: [{ nCodProd: 1 }],
    b: [{ nCodProd: 2 }, { nCodProd: 3 }],
  });
  assertEquals(r?.caminho, "b");
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizarItemPO — ausente ≠ zero (invariante money-path do repo)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("normalizarItemPO: string numérica vira número", () => {
  const i = normalizarItemPO({ nCodProd: 42, nQtde: "5", nQtdeRec: "0", cUnidade: "UN" });
  assertEquals(i.qtde, 5);
  assertEquals(i.recebido, 0);
  assertEquals(i.unidade, "UN");
});

Deno.test("normalizarItemPO: campo AUSENTE vira null, não 0", () => {
  // Number(undefined)=NaN e Number(null)=0 — ambos fabricariam fato. A sonda mede, não infere.
  const i = normalizarItemPO({ nCodProd: 42, nQtde: 5 });
  assertEquals(i.recebido, null);
  assertEquals(i.recebidoAusente, true);
});

Deno.test("normalizarItemPO: valor inválido vira null e marca o bruto", () => {
  const i = normalizarItemPO({ nCodProd: 1, nQtde: "5,5", nQtdeRec: "abc" });
  assertEquals(i.qtde, null);
  assertEquals(i.recebido, null);
  assertEquals(i.recebidoAusente, false);
  assertEquals(i.recebidoBruto, "abc");
});

Deno.test("normalizarItemPO: não confunde 0 legítimo com ausência", () => {
  const i = normalizarItemPO({ nCodProd: 1, nQtdeRec: 0 });
  assertEquals(i.recebido, 0);
  assertEquals(i.recebidoAusente, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// redigirSegredos — a saída da sonda é lida por humanos e colada em PR/chat
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("redigirSegredos: mascara app_key e app_secret", () => {
  const s = redigirSegredos('{"app_key":"abc123","app_secret":"s3cr3t","call":"X"}');
  assertEquals(s.includes("abc123"), false);
  assertEquals(s.includes("s3cr3t"), false);
  assertEquals(s.includes('"call":"X"'), true);
});

Deno.test("redigirSegredos: mascara mesmo com espaçamento alternativo", () => {
  const s = redigirSegredos('{ "app_secret" : "s3cr3t" }');
  assertEquals(s.includes("s3cr3t"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ehMetodoDeLeitura — a trava que torna "read-only ao Omie" uma propriedade, não uma promessa
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("ehMetodoDeLeitura: aceita os prefixos de consulta", () => {
  for (const m of ["ConsultarPedCompra", "ListarSaldoPendente", "PesquisarPedCompra", "ObterX"]) {
    assertEquals(ehMetodoDeLeitura(m), true, m);
  }
});

Deno.test("ehMetodoDeLeitura: NEGA toda escrita conhecida do fluxo de recebimento", () => {
  // Estes existem de verdade em omie-nfe-recebimento e MUDAM estado no ERP do founder.
  for (
    const m of [
      "AlterarRecebimento",
      "ConcluirRecebimento",
      "AlterarEtapaRecebimento",
      "IncluirPedCompra",
      "ExcluirRecebimento",
      "CancelarPedido",
      "AlterarProduto",
    ]
  ) {
    assertEquals(ehMetodoDeLeitura(m), false, m);
  }
});

Deno.test("ehMetodoDeLeitura: fail-closed em desconhecido, vazio e disfarce", () => {
  assertEquals(ehMetodoDeLeitura("MetodoNovoQualquer"), false);
  assertEquals(ehMetodoDeLeitura(""), false);
  assertEquals(ehMetodoDeLeitura("   "), false);
  // Não basta CONTER um prefixo de leitura — tem que COMEÇAR com ele.
  assertEquals(ehMetodoDeLeitura("AlterarConsultarRecebimento"), false);
  // Case-sensitive: o contrato do Omie é PascalCase; variação é desconhecido → negado.
  assertEquals(ehMetodoDeLeitura("consultarPedCompra"), false);
});
