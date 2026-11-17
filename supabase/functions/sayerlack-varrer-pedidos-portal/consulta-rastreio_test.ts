// Rastreio das consultas da página do portal (função que roda dentro do script do navegador). O comportamento dela no
// script real está em `script-navegador_test.ts`; aqui, só a regra: de qual PEDIDO veio cada resposta, o que ele levava
// e se outra resposta pode ter mexido na tabela.
//
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/sayerlack-varrer-pedidos-portal/
import { classificarFiltroDoPedido, contarLinhasNaResposta, criarRastreioConsulta, type DesfechoConsulta } from "./consulta-rastreio.ts";

// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}

/** Resposta boa com `total` linhas; o conteúdo (assinatura) é o do rótulo. */
const resposta = (total: unknown, conteudo = `lista-${total}`): DesfechoConsulta =>
  ({ ok: true, status: 200, total, chaves: ["recordsFiltered"], sucesso: true, mensagem: null, assinatura: conteudo });

Deno.test("resposta de pedido feito ANTES do nosso clique não é a resposta do clique (o incidente das 22:30)", () => {
  const r = criarRastreioConsulta();
  const daPagina = { quem: "carga inicial da tela" };
  r.pedida(daPagina, false, 0);
  assertEquals([r.emVoo(), r.clicar(1500)], [1, 1]);
  // A resposta dela chega DEPOIS do nosso clique — 48 ms depois, no caso medido em prod — com "0 de 0".
  r.respondida(daPagina, resposta(0), 1548);
  assertEquals([r.emVoo(), r.depoisDoClique(), r.respostaDoClique()], [0, 0, null]);
  // Só a do pedido que o clique gerou vale.
  const nosso = { quem: "nosso clique" };
  r.pedida(nosso, true, 1600);
  assertEquals([r.emVoo(), r.depoisDoClique(), r.respostaDoClique()], [1, 1, null]);
  r.respondida(nosso, resposta(9), 1850);
  assertEquals([r.emVoo(), r.respostaDoClique()?.total, r.respostaDoClique()?.pedido], [0, 9, 2]);
});

Deno.test("vale a resposta do PRIMEIRO pedido depois do clique — outra consulta da página não vale, chegue antes ou depois", () => {
  for (const ordemDeChegada of ["avulsa primeiro", "nosso primeiro"]) {
    const r = criarRastreioConsulta();
    r.clicar(0);
    const nosso = {}, avulsa = {};
    r.pedida(nosso, true, 1);
    r.pedida(avulsa, false, 2);
    if (ordemDeChegada === "avulsa primeiro") {
      r.respondida(avulsa, resposta(0), 50);
      assertEquals(r.respostaDoClique(), null);
      r.respondida(nosso, resposta(5), 250);
    } else {
      r.respondida(nosso, resposta(5), 250);
      r.respondida(avulsa, resposta(0), 650);
    }
    assertEquals([r.respostaDoClique()?.total, r.respostaDoClique()?.pedido, r.depoisDoClique()], [5, 1, 2]);
  }
});

Deno.test("cada clique nosso zera a conta: a resposta do clique anterior não vale para o seguinte (paginação, repetição)", () => {
  const r = criarRastreioConsulta();
  r.clicar(0);
  const pagina1 = {};
  r.pedida(pagina1, true, 1);
  r.respondida(pagina1, resposta(30), 250);
  assertEquals(r.respostaDoClique()?.total, 30);
  assertEquals([r.clicar(900), r.depoisDoClique(), r.respostaDoClique(), r.divergentes()], [1, 0, null, 0]);
});

Deno.test("pedido que morreu é desfecho RUIM (não fica esperando, não vira resposta boa); o 1º desfecho de um pedido é o que vale", () => {
  const r = criarRastreioConsulta();
  r.clicar(0);
  const morto = {};
  r.pedida(morto, true, 1);
  r.pedida(morto, true, 2); // o mesmo pedido não conta 2 vezes
  assertEquals([r.emVoo(), r.depoisDoClique()], [1, 1]);
  r.falhou(morto, 30);
  assertEquals([r.emVoo(), r.respostaDoClique()?.ok, r.respostaDoClique()?.total, r.respostaDoClique()?.falhou], [0, false, null, true]);
  // Corpo que chega depois da falha não troca o desfecho.
  r.respondida(morto, resposta(7), 40);
  assertEquals([r.respostaDoClique()?.ok, r.respostaDoClique()?.total], [false, null]);
});

Deno.test("pedido que nunca foi visto sair não conta — nem como resposta, nem como consulta em voo", () => {
  const r = criarRastreioConsulta();
  r.clicar(0);
  r.respondida({ quem: "fantasma" }, resposta(7), 10);
  r.falhou({ quem: "outro fantasma" }, 10);
  assertEquals([r.emVoo(), r.depoisDoClique(), r.respostaDoClique()], [0, 0, null]);
});

// ── A tabela só é nossa se nenhuma OUTRA resposta mexeu nela depois do clique (Codex, P0: contagem igual não prova) ──

Deno.test("divergentes: resposta de OUTRO conteúdo chegada depois do clique conta — venha de pedido anterior ou posterior a ele", () => {
  const r = criarRastreioConsulta();
  const pendurada = {}, nosso = {}, avulsa = {};
  r.pedida(pendurada, false, 0);
  r.clicar(1500);
  r.pedida(nosso, true, 1501);
  assertEquals(r.divergentes(), 0); // sem a resposta do clique não há o que comparar
  r.respondida(nosso, resposta(2, "pedidos A e B"), 1750);
  assertEquals(r.divergentes(), 0);
  // Pedido ANTERIOR ao clique respondendo depois dele, com as MESMAS 2 linhas de contagem e outro conteúdo.
  r.respondida(pendurada, resposta(2, "pedidos X e Y"), 1900);
  assertEquals(r.divergentes(), 1);
  // Pedido POSTERIOR ao clique, sem conteúdo legível: também é divergente.
  r.pedida(avulsa, null, 1950);
  r.respondida(avulsa, { ...resposta(2), assinatura: null }, 2100);
  assertEquals(r.divergentes(), 2);
});

Deno.test("divergentes: a MESMA resposta repetida não diverge; resposta chegada ANTES do clique e pedido que morreu não contam", () => {
  const r = criarRastreioConsulta();
  const antiga = {}, nosso = {}, gemea = {}, morto = {};
  r.pedida(antiga, false, 0);
  r.respondida(antiga, resposta(0, "vazia"), 200); // chegou antes do clique: a espera pela página a deixou passar
  r.clicar(1500);
  r.pedida(nosso, true, 1501);
  r.pedida(gemea, true, 1502); // a página consultando 2 vezes a mesma coisa num clique
  r.pedida(morto, false, 1503);
  r.respondida(nosso, resposta(2, "pedidos A e B"), 1750);
  r.respondida(gemea, resposta(2, "pedidos A e B"), 1760);
  r.falhou(morto, 1770);
  assertEquals([r.divergentes(), r.emVoo(), r.depoisDoClique()], [0, 0, 3]);
});

Deno.test("filtroDo: o que o pedido levava, como foi visto ao sair — e null para pedido que não existe", () => {
  const r = criarRastreioConsulta();
  r.pedida({ quem: "avulsa" }, false, 0);
  r.pedida({ quem: "nosso" }, true, 10);
  r.pedida({ quem: "ilegível" }, null, 20);
  assertEquals([r.filtroDo(1), r.filtroDo(2), r.filtroDo(3), r.filtroDo(4)], [false, true, null, null]);
});

Deno.test("linha do tempo: uma referência só (o 1º clique) e de qual clique nosso é cada consulta — inclusive depois de paginar", () => {
  const r = criarRastreioConsulta();
  const daPagina = {}, nosso = {}, pagina2 = {}, avulsa = {};
  r.pedida(daPagina, false, 1000);
  r.clicar(2500); // Filtrar
  r.respondida(daPagina, resposta(0), 2548);
  r.pedida(nosso, true, 2510);
  r.respondida(nosso, resposta(4), 2760);
  r.clicar(3300); // próxima página
  r.pedida(pagina2, true, 3310);
  r.pedida(avulsa, false, 3320);
  assertEquals(r.linhaDoTempo(), [
    { n: 1, clique: 0, do_clique: false, filtro: false, pedida_ms: -1500, respondida_ms: 48, status: 200, total: 0, sucesso: true, falhou: false },
    { n: 2, clique: 1, do_clique: true, filtro: true, pedida_ms: 10, respondida_ms: 260, status: 200, total: 4, sucesso: true, falhou: false },
    { n: 3, clique: 2, do_clique: true, filtro: true, pedida_ms: 810, respondida_ms: null, status: null, total: null, sucesso: null, falhou: false },
    { n: 4, clique: 2, do_clique: false, filtro: false, pedida_ms: 820, respondida_ms: null, status: null, total: null, sucesso: null, falhou: false },
  ]);
});

// ── O pedido levava o NOSSO filtro? Pelos CAMPOS que ele mandou, nunca por achar a data em qualquer lugar ──
// (Codex rodada 2: a emissão pedida igual à ENTREGA de outra consulta virava "sim"; `%2f` minúsculo virava "não".)

const NOSSO = { emissao: "2026-11-05", entrega: "2020-01-01", cliente: "46269", exibir: "1" };
const URL_LISTA = "http://portal.invalid:9092/order-viewer/form/list";
/** O corpo que o DataTables manda: boilerplate + os campos do formulário. */
const corpoForm = (campos: Record<string, string>) =>
  new URLSearchParams({ draw: "2", start: "0", length: "50", "columns[4][data]": "situacao", "search[value]": "", ...campos }).toString();
const NOSSOS_CAMPOS = { cliente: "46269", situacao: "todos", exibir: "1", num_ped_ini: "", num_ped_fim: "", data_emissao_ini: "2026-11-05", data_emissao_fim: "2026-11-12", data_entrega_ini: "2020-01-01" };
const classificar = (corpo: unknown, url = URL_LISTA) => classificarFiltroDoPedido(url, corpo, NOSSO);

Deno.test("filtro do pedido: os 4 campos batendo é true — em formulário, em JSON, com data BR, com hora, na query", () => {
  assertEquals(classificar(corpoForm(NOSSOS_CAMPOS)), true);
  assertEquals(classificar(JSON.stringify({ draw: 2, filtro: { ...NOSSOS_CAMPOS, cliente: 46269, exibir: 1 } })), true);
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, data_emissao_ini: "05/11/2026", data_entrega_ini: "01/01/2020" })), true);
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, data_emissao_ini: "2026-11-05T00:00:00.000Z", data_entrega_ini: "01-01-2020 00:00" })), true);
  assertEquals(classificar(undefined, `${URL_LISTA}?${corpoForm(NOSSOS_CAMPOS)}`), true);
  // Percent-encoding MINÚSCULO da barra (o `indexOf` sensível a caixa lia isto como outro filtro).
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, data_emissao_ini: "05/11/2026", data_entrega_ini: "01/01/2020" }).replaceAll("%2F", "%2f")), true);
});

Deno.test("filtro do pedido: emissão (ou entrega) com OUTRA data é false — inclusive com a nossa data no campo errado", () => {
  // O formulário padrão do portal: último mês.
  assertEquals(classificar(corpoForm({ cliente: "", situacao: "todos", exibir: "0", data_emissao_ini: "2026-10-11", data_emissao_fim: "2026-11-11", data_entrega_ini: "2026-10-11" })), false);
  // A NOSSA data aparece, mas na ENTREGA; a emissão é outra (o caso do Codex).
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, data_emissao_ini: "2026-10-11", data_emissao_fim: "2026-11-11", data_entrega_ini: "2026-11-05" })), false);
  // Emissão certa e entrega ainda no padrão: consulta disparada no meio da aplicação dos filtros.
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, data_entrega_ini: "2026-10-11" })), false);
  // Sem nome de campo reconhecível, mas mostrando datas e nenhuma sendo a nossa.
  assertEquals(classificar(corpoForm({ de: "2026-10-11", ate: "2026-11-11" })), false);
});

Deno.test("filtro do pedido: o que não dá para saber é null — nunca true por achar a data, nunca false por não achar", () => {
  assertEquals(classificar(undefined), null); // sem corpo
  assertEquals(classificar(""), null);
  assertEquals(classificar(corpoForm({})), null); // só o boilerplate do DataTables: nenhuma data
  // A nossa data existe no pedido, mas em campo sem nome reconhecível: não promove a prova positiva.
  assertEquals(classificar(corpoForm({ de: "2026-11-05", ate: "2026-11-12" })), null);
  // Emissão nossa, mas o pedido não manda entrega, cliente ou exibir: não dá para afirmar os 4.
  assertEquals(classificar(corpoForm({ data_emissao_ini: "2026-11-05" })), null);
  // Cliente ou exibir com outro valor não viram "não" (são valores soltos; campo vizinho de nome parecido existe)…
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, cliente: "2059" })), null);
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, exibir: "0" })), null);
  // …e campo vizinho VAZIO de nome parecido não atrapalha o true.
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, pedido_cliente: "", nome_cliente: "" })), true);
  assertEquals(classificar("{isto não é json"), null);
});

Deno.test("filtro do pedido: campo VIZINHO não prova nem absolve — fim do intervalo, pedido_cliente, exibir_inativos (Codex rodada 3)", () => {
  // A nossa emissão aparece no FIM do intervalo de outra consulta; o INÍCIO é outro.
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, data_emissao_ini: "2026-10-01", data_emissao_fim: "2026-11-05" })), false);
  // O nosso cliente aparece em `pedido_cliente`; o campo `cliente` é outro.
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, cliente: "2059", pedido_cliente: "46269" })), null);
  // `exibir` é 0; quem vale 1 é `exibir_inativos`.
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, exibir: "0", exibir_inativos: "1" })), null);
  // Controle: os mesmos vizinhos, com os campos certos batendo, não atrapalham.
  assertEquals(classificar(corpoForm({ ...NOSSOS_CAMPOS, pedido_cliente: "2148220", exibir_inativos: "0" })), true);
});

Deno.test("filtro do pedido: o NOSSO pedido em formato menos óbvio não vira 'outro filtro' (Codex rodada 3, P2)", () => {
  // O valor do campo dentro de um objeto { value }.
  assertEquals(classificar(JSON.stringify({ data_emissao_ini: { value: "2026-11-05" }, data_emissao_fim: "2026-11-12", data_entrega_ini: { value: "2020-01-01" }, cliente: "46269", exibir: "1" })), true);
  // O filtro como busca de COLUNA do DataTables: columns[i][data] dá o nome, columns[i][search][value] dá o valor.
  assertEquals(classificar(corpoForm({ "columns[0][data]": "data_emissao_ini", "columns[0][search][value]": "2026-11-05", data_emissao_fim: "2026-11-12", data_entrega_ini: "2020-01-01", cliente: "46269", exibir: "1" })), true);
  // O serializeArray do jQuery: [{ name, value }].
  const pares = Object.entries(NOSSOS_CAMPOS).map(([name, value]) => ({ name, value }));
  assertEquals(classificar(JSON.stringify(pares)), true);
  // Só o FIM tem nome; o início vem numa estrutura sem nome: a nossa data está no pedido ⇒ não dá para dizer "não".
  assertEquals(classificar(JSON.stringify({ periodo: ["2026-11-05", "2026-11-12"], data_emissao_fim: "2026-11-12" })), null);
});

// ── A medida das linhas na resposta (sem veto): só a coluna Pedido, e o número inteiro ──

Deno.test("linhas na resposta: conta só o nº da coluna Pedido, inteiro — não o Pedido Cliente, não um pedaço de outro número", () => {
  const corpo = JSON.stringify({ data: [{ nr_pedido: 2148220, pedido_cliente: "46269" }, { nr_pedido: 21482230, pedido_cliente: "777" }] });
  const linhas = [
    { "Pedido": "2148220", "Pedido Cliente": "46269" }, // está na resposta
    { "Pedido": "2099001", "Pedido Cliente": "46269" }, // só o Pedido Cliente dela aparece na resposta
    { "Pedido": "2148223", "Pedido Cliente": "1" }, // aparece só como pedaço de 21482230
    { "Pedido": "", "Pedido Cliente": "2148220" }, // sem nº de pedido
  ];
  assertEquals(contarLinhasNaResposta(linhas, corpo), 1);
  assertEquals(contarLinhasNaResposta(linhas, ""), 0);
  assertEquals(contarLinhasNaResposta([{ " pedido ": " 2148220 " }], "2148220"), 1); // início e fim do texto contam como borda
});
