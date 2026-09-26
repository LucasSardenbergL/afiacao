// Régua do e-mail do disparo (pedido do founder, 2026-09-25). Roda:
//   deno test supabase/functions/disparar-pedidos-aprovados/email-politica_test.ts
//
// O que ela defende: o founder recebe o e-mail de pedido IMPLANTADO na Sayerlack, com o nº da
// fábrica; o resumo "Pedidos disparados" só volta quando há problema que exige ação; e o corte sem
// nada ("0 pedidos, R$ 0,00") e o corte em que o portal só foi enfileirado ficam mudos.
import {
  assuntoImplantado,
  assuntoProblema,
  ehImplantadoNaSayerlack,
  ehProblemaQueAvisa,
  escapeHtml,
  formatarDataIso,
  formatarValor,
  htmlImplantado,
  motivoSemEmail,
  planejarEmailsDoDisparo,
  type ResultadoEmail,
} from "./email-politica.ts";

function eq(a: unknown, b: unknown, msg: string) {
  const sa = JSON.stringify(a) ?? "<undefined>";
  const sb = JSON.stringify(b) ?? "<undefined>";
  if (sa !== sb) throw new Error(`${msg}: ${sa} !== ${sb}`);
}
function contem(texto: string, trecho: string, msg: string) {
  if (!texto.includes(trecho)) throw new Error(`${msg}: não contém ${JSON.stringify(trecho)}`);
}
function naoContem(texto: string, trecho: string, msg: string) {
  if (texto.includes(trecho)) throw new Error(`${msg}: contém ${JSON.stringify(trecho)}`);
}

const APP = "https://app.exemplo";

function r(over: Partial<ResultadoEmail>): ResultadoEmail {
  return { pedido_id: 2401, fornecedor: "RENNER SAYERLACK S/A", status_final: "disparado", valor: 1605.67, ...over };
}

// Os desfechos reais de um dia de compra, como a edge os produz.
const IMPLANTADO = r({ protocolo_portal: "2126906", omie_numero: "4512", portal_data_entrega: "2026-09-30" });
const PORTAL_ENFILEIRADO = r({ pedido_id: 2402, status_final: "aguardando_portal_sayerlack" });
const OUTRO_FORNECEDOR_OK = r({ pedido_id: 2403, fornecedor: "ACRE CAXIAS", omie_numero: "4513" });
const FALHA_OMIE = r({ pedido_id: 2404, fornecedor: "BETA", status_final: "falha_envio" });
const FALHA_OMIE_POS_PORTAL = r({ pedido_id: 2405, status_final: "falha_envio", protocolo_portal: "2126907" });
const BARRADO_MINIMO = r({ pedido_id: 2406, status_final: "falha_envio", gate_minimo: true });
const SEM_REGISTRO = r({ pedido_id: 2407, status_final: "disparado_sem_registro", protocolo_portal: "2126908" });
const NAO_DISPARADO = r({ pedido_id: 2408, status_final: "nao_disparado" });
const CONCILIACAO = r({ pedido_id: 2409, status_final: "portal_requer_conciliacao" });

Deno.test("corte das 10:00 sem nada aprovado: nenhum e-mail (o '0 pedidos, R$ 0,00' morreu)", () => {
  const plano = planejarEmailsDoDisparo("producao", []);
  eq(plano, { resumoDryRun: false, implantados: [], problemas: [] }, "plano vazio");
  eq(motivoSemEmail([]), "sem e-mail: nenhum pedido neste run", "motivo registrado na auditoria");
});

Deno.test("corte que só enfileira o portal / fornecedor sem portal disparado ok: nenhum e-mail", () => {
  const plano = planejarEmailsDoDisparo("producao", [PORTAL_ENFILEIRADO, OUTRO_FORNECEDOR_OK, CONCILIACAO]);
  eq(plano.implantados.length, 0, "nada implantado na Sayerlack neste run");
  eq(plano.problemas.length, 0, "enfileirado, disparado e conciliação (Sentinela cobre) não são problema do run");
});

Deno.test("run pós-portal que registra no Omie: e-mail de IMPLANTADO com o nº da fábrica", () => {
  const plano = planejarEmailsDoDisparo("producao", [IMPLANTADO]);
  eq(plano.implantados.map((x) => x.pedido_id), [2401], "o pedido implantado");
  eq(plano.problemas.length, 0, "sem problema");
  // O Intl pt-BR separa "R$" do número com espaço NÃO-quebrável (U+00A0) — escrito explícito aqui,
  // senão o esperado com espaço comum nunca casa (e um `naoContem("R$ 0,00")` ficaria cego).
  eq(assuntoImplantado(plano.implantados), "Pedido implantado na Sayerlack — nº 2126906 (R$ 1.605,67)", "assunto");
  const html = htmlImplantado("OBEN", plano.implantados, APP, "25/09/2026, 10:02:11");
  contem(html, ">2126906<", "nº da fábrica em destaque");
  contem(html, `${APP}/admin/reposicao/pedidos?id=2401`, "link do pedido no app");
  contem(html, "4512", "nº do PO no Omie");
  contem(html, "30/09/2026", "previsão de entrega do portal");
});

Deno.test("reconciliado (PO já existia no Omie) também é implantado — o protocolo é o que decide", () => {
  eq(ehImplantadoNaSayerlack(r({ protocolo_portal: "2126906", reconciliado: true } as Partial<ResultadoEmail>)), true, "reconciliado");
});

Deno.test("sem protocolo NÃO é implantado — nem com protocolo vazio/só espaço", () => {
  eq(ehImplantadoNaSayerlack(OUTRO_FORNECEDOR_OK), false, "fornecedor sem portal");
  eq(ehImplantadoNaSayerlack(r({ protocolo_portal: "" })), false, "vazio");
  eq(ehImplantadoNaSayerlack(r({ protocolo_portal: "   " })), false, "só espaço");
  eq(ehImplantadoNaSayerlack(r({ protocolo_portal: null })), false, "null");
  // Protocolo presente mas o Omie não registrou: é PROBLEMA, não implantado-com-sucesso.
  eq(ehImplantadoNaSayerlack(FALHA_OMIE_POS_PORTAL), false, "falha no Omie pós-portal");
  eq(ehImplantadoNaSayerlack(SEM_REGISTRO), false, "PO sem registro local");
});

Deno.test("problema que exige ação dispara o e-mail de exceção — o barrado pelo mínimo não", () => {
  const plano = planejarEmailsDoDisparo("producao", [FALHA_OMIE, FALHA_OMIE_POS_PORTAL, BARRADO_MINIMO, SEM_REGISTRO, NAO_DISPARADO]);
  eq(plano.problemas.map((x) => x.pedido_id), [2404, 2405, 2407, 2408], "problemas");
  eq(ehProblemaQueAvisa(BARRADO_MINIMO), false, "gate de mínimo é benigno (#1222)");
  eq(plano.implantados.length, 0, "nenhum implantado");
  eq(assuntoProblema("OBEN", 4), "⚠️ Problema no disparo de pedidos — 4 pedido(s) — OBEN", "assunto");
});

Deno.test("run misto: implantado E problema saem os dois, cada um com o seu pedido", () => {
  const plano = planejarEmailsDoDisparo("producao", [IMPLANTADO, FALHA_OMIE, PORTAL_ENFILEIRADO]);
  eq(plano.implantados.map((x) => x.pedido_id), [2401], "implantado");
  eq(plano.problemas.map((x) => x.pedido_id), [2404], "problema");
});

Deno.test("dry_run mantém o resumo de sempre (lá o IncluirPedCompra cria PO REAL no Omie)", () => {
  const plano = planejarEmailsDoDisparo("dry_run", [r({ status_final: "disparado_simulado" })]);
  eq(plano, { resumoDryRun: true, implantados: [], problemas: [] }, "dry_run");
  eq(planejarEmailsDoDisparo("dry_run", []).resumoDryRun, true, "dry_run vazio também");
});

Deno.test("vários implantados no mesmo run (lotes de um split): um e-mail, todos os números", () => {
  const lote1 = r({ pedido_id: 2410, protocolo_portal: "2126910", split_parent_id: 2400, split_lote: 1, split_total: 2 });
  const lote2 = r({ pedido_id: 2411, protocolo_portal: "2126911", split_parent_id: 2400, split_lote: 2, split_total: 2 });
  eq(assuntoImplantado([lote1, lote2]), "2 pedidos implantados na Sayerlack — nº 2126910, 2126911", "assunto");
  const html = htmlImplantado("OBEN", [lote1, lote2], APP, "agora");
  contem(html, "lote 1/2 do #2400", "lote 1");
  contem(html, "lote 2/2 do #2400", "lote 2");
});

Deno.test("ausente ≠ zero: valor não positivo some do assunto e vira '—' no corpo", () => {
  eq(formatarValor(0), null, "zero não é valor provado");
  eq(formatarValor(null), null, "null");
  eq(formatarValor(Number.NaN), null, "NaN");
  const semValor = r({ protocolo_portal: "2126906", valor: 0 });
  eq(assuntoImplantado([semValor]), "Pedido implantado na Sayerlack — nº 2126906", "assunto sem valor inventado");
  // Casa só os dígitos ("0,00"), imune ao separador entre "R$" e o número; o controle prova que a
  // mesma busca ENXERGA um valor quando ele existe.
  naoContem(htmlImplantado("OBEN", [semValor], APP, "agora"), "0,00", "corpo sem R$ 0,00 inventado");
  contem(htmlImplantado("OBEN", [r({ protocolo_portal: "2126906" })], APP, "agora"), "1.605,67", "controle: valor real aparece");
});

Deno.test("data do portal: só ISO vira data; o resto não é adivinhado", () => {
  eq(formatarDataIso("2026-09-30"), "30/09/2026", "ISO");
  eq(formatarDataIso("30/09/2026"), null, "formato BR não é reinterpretado");
  eq(formatarDataIso(""), null, "vazio");
  eq(formatarDataIso(null), null, "null");
  naoContem(htmlImplantado("OBEN", [r({ protocolo_portal: "1", portal_data_entrega: null })], APP, "agora"), "Previsão de entrega", "sem data, sem linha");
});

Deno.test("texto dinâmico é escapado no HTML", () => {
  eq(escapeHtml(`<b>"x"&'y'</b>`), "&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;", "escape");
  const html = htmlImplantado("OBEN", [r({ protocolo_portal: "2126906", fornecedor: "<script>x</script>" })], APP, "agora");
  naoContem(html, "<script>", "fornecedor escapado");
});
