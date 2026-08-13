// Testa o CÓDIGO REAL de sondas.ts no runtime real (Deno), sem import remoto (test:edges roda
// com --no-remote). Roda com: deno test supabase/functions/omie-sonda-recebimento/sondas_test.ts
//
// O que estas funções sustentam: a sonda EXISTE para descobrir o contrato do Omie, não para
// confirmar um contrato assumido ("nome de endpoint não é contrato" — Codex, spec 2026-08-13).
// Por isso todo o núcleo puro é agnóstico à forma do payload: inventaria caminhos de chave,
// localiza a lista de itens onde quer que ela esteja, e classifica um método inexistente como
// RESULTADO (fault), não como crash.

import {
  buscarValorProfundo,
  caminhosDeChave,
  classificarAssociacao,
  classificarResposta,
  diffCaminhos,
  ehMetodoDeLeitura,
  escolherPorNotaDiversa,
  etapaDaPO,
  idNativo,
  localizarItens,
  normalizarItemPO,
  normalizarItemRecebimento,
  redigirSegredos,
  servicosConhecidos,
  urlDoServico,
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

Deno.test("localizarItens: acha itensRecebimento[] com as chaves ANINHADAS", () => {
  // BUG achado pelo Codex: itensRecebimento[] tem itensCabec/itensAjustes aninhados, e a versão
  // que só olhava as chaves no topo do elemento não encontrava nada — a S2 voltaria "sem itens"
  // num payload cheio deles, e eu leria isso como "o Omie não expõe a associação".
  const payload = {
    itensRecebimento: [
      { itensCabec: { nIdProduto: 1, nQtdeNFe: 2 }, itensAjustes: { nQtdeRecebida: 2 } },
      { itensCabec: { nIdProduto: 3, nQtdeNFe: 4 }, itensAjustes: { nQtdeRecebida: 4 } },
    ],
  };
  const r = localizarItens(payload);
  assertEquals(r?.caminho, "itensRecebimento");
  assertEquals(r?.itens.length, 2);
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
// idNativo — "0" e 123 são mundos opostos nesta decisão (Codex)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("idNativo: zero em qualquer forma é AUSÊNCIA de vínculo, não vínculo com id 0", () => {
  // O ponto do Codex: `nIdPedido: 0` significa "não associado". Tratar como id válido
  // transformaria "sem vínculo" em "vínculo com a PO 0" — falso positivo no coração da medição.
  assertEquals(idNativo(0), null);
  assertEquals(idNativo("0"), null);
  assertEquals(idNativo("000"), null);
  assertEquals(idNativo(""), null);
  assertEquals(idNativo("  "), null);
  assertEquals(idNativo(null), null);
  assertEquals(idNativo(undefined), null);
});

Deno.test("idNativo: id real vira string estável", () => {
  assertEquals(idNativo(123), "123");
  assertEquals(idNativo("123"), "123");
  assertEquals(idNativo(" 123 "), "123");
});

// ─────────────────────────────────────────────────────────────────────────────
// buscarValorProfundo — acha o campo sem hardcodar ONDE ele mora
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("buscarValorProfundo: acha em objeto aninhado", () => {
  // itensRecebimento[] tem itensCabec/itensAjustes/itensInfoAdic ANINHADOS — o Codex mostrou
  // que procurar a chave no topo do elemento não encontra nada.
  const item = { itensCabec: { nIdPedido: 77 }, itensAjustes: { nQtdeRecebida: 3 } };
  assertEquals(buscarValorProfundo(item, ["nIdPedido"]), 77);
  assertEquals(buscarValorProfundo(item, ["nQtdeRecebida"]), 3);
});

Deno.test("buscarValorProfundo: primeiro nome da lista que existir vence", () => {
  const item = { a: { cChaveNFe: "x" }, b: { cChaveNfe: "y" } };
  assertEquals(buscarValorProfundo(item, ["cChaveNFe", "cChaveNfe"]), "x");
  assertEquals(buscarValorProfundo(item, ["cChaveNfe", "cChaveNFe"]), "y");
});

Deno.test("buscarValorProfundo: ausente devolve undefined (não null, não 0)", () => {
  assertEquals(buscarValorProfundo({ x: 1 }, ["nIdPedido"]), undefined);
  assertEquals(buscarValorProfundo(null, ["nIdPedido"]), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizarItemRecebimento + classificarAssociacao — o núcleo da S2
// ─────────────────────────────────────────────────────────────────────────────

const ALVO = { idPedido: "1001", numeroPedido: "1133" };

Deno.test("classificarAssociacao: vínculo nativo por ITEM que casa com a PO alvo", () => {
  const item = normalizarItemRecebimento({
    itensCabec: { nIdItem: 9, nIdPedido: 1001, nIdItPedido: 5501, nIdProduto: 42 },
  });
  assertEquals(item.idPedido, "1001");
  assertEquals(item.idItemPedido, "5501");
  assertEquals(classificarAssociacao(item, ALVO), "native_exact");
});

Deno.test("classificarAssociacao: nativo apontando OUTRA PO (nota consolidada)", () => {
  // 94% das POs alvo dividem nota — este caso é o esperado, não a exceção.
  const item = normalizarItemRecebimento({ itensCabec: { nIdPedido: 2002, nIdItPedido: 7 } });
  assertEquals(classificarAssociacao(item, ALVO), "native_other_po");
});

Deno.test("classificarAssociacao: cabeçalho casa mas SEM item — não é exact", () => {
  // Exclusividade de cabeçalho não prova propriedade do item (§3.4 do spec).
  const item = normalizarItemRecebimento({ itensCabec: { nIdPedido: 1001, nIdItPedido: 0 } });
  assertEquals(classificarAssociacao(item, ALVO), "native_sem_item");
});

Deno.test("classificarAssociacao: só o hint TEXTUAL do XML — o caso que o sync usa hoje", () => {
  // omie-sync-nfes-recebidas cria o vínculo por itensInfoAdic.nNumPedCompra, não pelo id nativo.
  // Se for só isto, "PO recebida" é inferência do espelho, não estado do Omie.
  const item = normalizarItemRecebimento({
    itensCabec: { nIdPedido: 0, nIdItPedido: 0 },
    itensInfoAdic: { nNumPedCompra: "1133", cNumItPedCompra: "1" },
  });
  assertEquals(item.idPedido, null);
  assertEquals(item.numPedidoTexto, "1133");
  assertEquals(classificarAssociacao(item, ALVO), "xml_hint_only");
});

Deno.test("classificarAssociacao: hint textual de OUTRA PO não vira vínculo do alvo", () => {
  const item = normalizarItemRecebimento({ itensInfoAdic: { nNumPedCompra: "9999" } });
  assertEquals(classificarAssociacao(item, ALVO), "xml_hint_outra_po");
});

Deno.test("classificarAssociacao: só produto, e nada", () => {
  assertEquals(
    classificarAssociacao(normalizarItemRecebimento({ itensCabec: { nIdProduto: 42 } }), ALVO),
    "product_only",
  );
  assertEquals(
    classificarAssociacao(normalizarItemRecebimento({ itensCabec: {} }), ALVO),
    "unassociated",
  );
});

Deno.test("normalizarItemRecebimento: captura quantidade, unidade, local e o flag de estoque", () => {
  const item = normalizarItemRecebimento({
    itensCabec: { nQtdeNFe: "10", cUnidadeNfe: "KG", nIdProduto: 42, cCodigoProduto: "PRD1" },
    itensAjustes: { nQtdeRecebida: 3, codigo_local_estoque: 77, cNaoGerarMovEstoque: "S" },
  });
  assertEquals(item.qtdeNfe, 10);
  assertEquals(item.qtdeRecebida, 3);
  assertEquals(item.unidade, "KG");
  assertEquals(item.localEstoque, "77");
  assertEquals(item.naoGeraMovEstoque, "S");
  assertEquals(item.codigoProduto, "PRD1");
});

Deno.test("normalizarItemRecebimento: quantidade ausente é null, não 0", () => {
  const item = normalizarItemRecebimento({ itensCabec: { nIdProduto: 1 } });
  assertEquals(item.qtdeNfe, null);
  assertEquals(item.qtdeRecebida, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// etapaDaPO — usada no fallback quando o filtro jsonb do PostgREST não estiver disponível
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("etapaDaPO: lê a etapa do cabeçalho", () => {
  assertEquals(etapaDaPO({ cabecalho_consulta: { cEtapa: "15" } }), "15");
});

Deno.test("etapaDaPO: aceita número e normaliza espaço", () => {
  assertEquals(etapaDaPO({ cabecalho_consulta: { cEtapa: 15 } }), "15");
  assertEquals(etapaDaPO({ cabecalho_consulta: { cEtapa: " 15 " } }), "15");
});

Deno.test("etapaDaPO: forma inesperada devolve null, não string vazia", () => {
  // "não sei" tem que ficar distinguível de "é outra etapa" — senão o fallback silencia POs.
  assertEquals(etapaDaPO(null), null);
  assertEquals(etapaDaPO({}), null);
  assertEquals(etapaDaPO({ cabecalho_consulta: null }), null);
  assertEquals(etapaDaPO({ cabecalho_consulta: { cEtapa: "" } }), null);
  assertEquals(etapaDaPO({ cabecalho_consulta: { cEtapa: null } }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// ehMetodoDeLeitura — a trava que torna "read-only ao Omie" uma propriedade, não uma promessa
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// escolherPorNotaDiversa — 94% das POs alvo dividem nota; amostra ingênua mede uma nota só
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("escolherPorNotaDiversa: nunca devolve duas POs da MESMA nota", () => {
  const linhas = [
    { nid_receb: 1, po: "a" },
    { nid_receb: 1, po: "b" },
    { nid_receb: 1, po: "c" },
    { nid_receb: 2, po: "d" },
    { nid_receb: 3, po: "e" },
  ];
  const r = escolherPorNotaDiversa(linhas, 3);
  assertEquals(r.length, 3);
  assertEquals(new Set(r.map((x) => x.nid_receb)).size, 3);
});

Deno.test("escolherPorNotaDiversa: cobre os dois extremos — nota consolidada E exclusiva", () => {
  // A primeira escolha é a nota mais consolidada (atribuição ambígua, caso dominante); a
  // segunda é a mais exclusiva (o caso raro). Os dois decidem coisas diferentes no ledger.
  const linhas = [
    { nid_receb: 9, po: "x" }, // nota exclusiva
    { nid_receb: 7, po: "a" },
    { nid_receb: 7, po: "b" },
    { nid_receb: 7, po: "c" }, // nota com 3 POs
  ];
  const r = escolherPorNotaDiversa(linhas, 2);
  assertEquals(r.map((x) => x.nid_receb), [7, 9]);
});

Deno.test("escolherPorNotaDiversa: ignora linha sem nota e respeita o limite", () => {
  const linhas = [
    { nid_receb: null, po: "z" },
    { nid_receb: 5, po: "a" },
    { nid_receb: 6, po: "b" },
  ];
  assertEquals(escolherPorNotaDiversa(linhas, 5).length, 2);
  assertEquals(escolherPorNotaDiversa(linhas, 1).length, 1);
  assertEquals(escolherPorNotaDiversa([], 3), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// urlDoServico — a credencial NUNCA pode ir para uma URL vinda do corpo (SSRF)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("urlDoServico: resolve serviço conhecido para URL do Omie", () => {
  assertEquals(
    urlDoServico("estoque_consulta"),
    "https://app.omie.com.br/api/v1/estoque/consulta/",
  );
});

Deno.test("urlDoServico: NEGA qualquer coisa que não seja um serviço do enum", () => {
  // O ataque que isto fecha: a edge envia app_key/app_secret no corpo da requisição. Se o
  // destino viesse do corpo, quem chama a sonda exfiltraria a credencial do ERP para um host
  // próprio. A URL não pode ser dado de entrada — nem parcialmente.
  for (
    const tentativa of [
      "https://evil.example.com/",
      "http://app.omie.com.br.evil.example/",
      "https://app.omie.com.br/api/v1/estoque/consulta/",
      "//evil.example.com",
      "estoque_consulta/../../x",
      "ESTOQUE_CONSULTA",
      "",
      "   ",
    ]
  ) {
    assertEquals(urlDoServico(tentativa), null, `deveria negar: ${tentativa}`);
  }
});

Deno.test("urlDoServico: todo destino do enum é https no host do Omie", () => {
  for (const nome of servicosConhecidos()) {
    const url = urlDoServico(nome);
    assertEquals(url !== null, true, nome);
    assertEquals(url!.startsWith("https://app.omie.com.br/api/v1/"), true, `${nome} → ${url}`);
  }
});

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
