// Testa o CÓDIGO REAL de listagem.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-nfes-recebidas/listagem_test.ts
//
// O que fecha (OBEN, medido em 2026-10-06): a janela de 3 dias sem documento nenhum (fim de semana,
// feriado) faz a Omie responder a fault canônica de fim, "Não existem registros para a página". O
// regex do laço de páginas não a reconhecia: virava `erros++`, o run fechava `error` com "0 NFes
// processadas com 1 erro(s) — rate-limit/Omie?" e o watchdog disparava alerta crítico FALSO — em
// 07-05, 07-20, 08-04, 09-08 e 10-06 (00:16 UTC, 1,5 s, sem retentativa). A irmã
// `omie-sync-ctes-recebidos`, no MESMO endpoint, já tratava essa fault como fim.
//
// As falsificações que importam:
//   (a) a fault canônica, com e sem acento, É fim na PÁGINA 1 (a janela vazia);
//   (b) na página > 1 — sempre DENTRO do total declarado, o laço não pede além dele — a mesma fault
//       é anomalia (a listagem encolheu entre páginas, ou a Omie superestimou o total): continua
//       erro VISÍVEL, como antes. Aceitá-la ali fecharia o run `complete` com o parcial escondido
//       (revisão adversarial, P3-a). A irmã `omie-sync-ctes-recebidos` trata a mesma coisa como
//       anomalia;
//   (b2) os textos de fim que o regex antigo já aceitava continuam aceitos em qualquer página;
//   (c) fault que não é fim — rate-limit, credencial, erro interno, "consumo redundante" — NÃO é
//       fim: tratá-la como fim fecharia o run `complete` com a listagem PARCIAL.
import { ehFimDaListagem } from "./listagem.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

// O texto REAL, capturado no mesmo endpoint em 2026-10-05 (HTTP 500): ver
// omie-nfe-recebimento-sync/listagem_test.ts.
const CANONICAS = [
  "ERROR: Não existem registros para a página [1]!",
  "Não existem registros para a página [1]!",
  "Nao existem registros para a pagina 1",
  "NÃO EXISTEM REGISTROS PARA A PÁGINA 1",
];

Deno.test("a fault canônica de fim encerra a listagem na PÁGINA 1 (janela vazia)", () => {
  for (const f of CANONICAS) assertEquals(ehFimDaListagem(f, 1), true, f);
});

Deno.test("a mesma fault na página > 1 é ANOMALIA, não fim: o parcial continua visível como erro", () => {
  for (const pagina of [2, 3, 17]) {
    for (const f of CANONICAS) assertEquals(ehFimDaListagem(f, pagina), false, `página ${pagina}: ${f}`);
  }
});

Deno.test("os textos de fim que o laço já aceitava continuam aceitos, em qualquer página", () => {
  const legados = ["Nenhum registro encontrado", "Consulta sem registros", "Recebimento não encontrado", "Not found"];
  for (const pagina of [1, 3]) {
    for (const f of legados) assertEquals(ehFimDaListagem(f, pagina), true, `página ${pagina}: ${f}`);
  }
});

Deno.test("fault que não é fim NÃO encerra a listagem (seria retrato parcial com cara de completo)", () => {
  const naoFim = [
    "Consumo redundante detectado. Aguarde 50 segundos (REDUNDANT)",
    "Chave de acesso não cadastrada para o aplicativo [1503123456]",
    "ERROR: Erro interno do servidor",
    "Requisição bloqueada por excesso de requisições (rate limit)",
    "Não existem registros",
    "",
  ];
  for (const f of naoFim) assertEquals(ehFimDaListagem(f, 1), false, JSON.stringify(f));
});
