// Testa o CÓDIGO REAL de payload.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/analytics-outbox-drain/payload_test.ts
//
// O que está em jogo: este módulo constrói a chave de deduplicação do PostHog.
// A doc oficial (posthog.com/docs/data/events, lida em 2026-08-25) diz que
// `uuid + event + timestamp + distinct_id` IDÊNTICOS são o que faz um retry ser
// tratado como duplicata. Se qualquer um dos quatro variar entre tentativas, o
// retry vira evento NOVO — e a contagem de aprovações de compra, que é
// justamente a métrica que decide ligar a auto-aprovação, sai INFLADA pela
// própria infraestrutura de reenvio. Por isso o teste do timestamp abaixo pesa
// mais que os outros: ele é o que separa "reenviar" de "contar duas vezes".
import {
  classificarResposta,
  ehSintetico,
  LIB_OUTBOX,
  type LinhaOutbox,
  montarEvento,
  particionar,
  resumirErro,
} from "./payload.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const LINHA_SISTEMA: LinhaOutbox = {
  id: 1,
  event_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  evento: "reposicao.sugestao_aprovada",
  distinct_id: "sistema:reposicao",
  props: { sugestao_id: 7001, aprovacao_humana: true },
  ocorrido_em: "2026-08-25T12:00:00.000Z",
  tentativas: 0,
};

const LINHA_TITULAR: LinhaOutbox = {
  id: 2,
  event_id: "11111111-2222-3333-4444-555555555555",
  evento: "carteira.mixgap_servido",
  distinct_id: "99999999-9999-9999-9999-999999999999",
  props: { estado: "com_gap" },
  ocorrido_em: "2026-08-25T13:30:00.000Z",
  tentativas: 2,
};

// ── os quatro campos de dedup vêm da LINHA, nunca do relógio ──

Deno.test("uuid vai TOP-LEVEL e e o event_id persistido", () => {
  assertEquals(montarEvento(LINHA_SISTEMA).uuid, LINHA_SISTEMA.event_id);
});

Deno.test("timestamp e o ocorrido_em persistido — nao o relogio do worker", () => {
  assertEquals(montarEvento(LINHA_SISTEMA).timestamp, "2026-08-25T12:00:00.000Z");
});

Deno.test("retry produz payload IDENTICO — e o que faz a dedup funcionar", () => {
  const primeira = montarEvento(LINHA_SISTEMA);
  const retry = montarEvento({ ...LINHA_SISTEMA, tentativas: 5 });
  // os quatro campos de dedup, um a um: um assert só no objeto inteiro
  // esconderia QUAL deles escorregou.
  assertEquals(retry.uuid, primeira.uuid);
  assertEquals(retry.event, primeira.event);
  assertEquals(retry.timestamp, primeira.timestamp);
  assertEquals(retry.distinct_id, primeira.distinct_id);
});

Deno.test("$insert_id NAO e usado — nao e a chave de dedup desta API", () => {
  assertEquals("$insert_id" in montarEvento(LINHA_SISTEMA).properties, false);
});

// ── separação de canos e de pessoa ──

Deno.test("marca $lib para a leitura separar este cano do browser", () => {
  assertEquals(montarEvento(LINHA_TITULAR).properties.$lib, LIB_OUTBOX);
});

Deno.test("fato do sistema nao cria perfil de pessoa", () => {
  assertEquals(montarEvento(LINHA_SISTEMA).properties.$process_person_profile, false);
});

Deno.test("evento com titular real CRIA perfil (a flag nao vaza para ele)", () => {
  assertEquals("$process_person_profile" in montarEvento(LINHA_TITULAR).properties, false);
});

Deno.test("distinct_id do titular casa com o identify(userId) do front", () => {
  assertEquals(montarEvento(LINHA_TITULAR).distinct_id, LINHA_TITULAR.distinct_id);
});

Deno.test("ehSintetico separa id de sistema de uuid de pessoa", () => {
  assertEquals(ehSintetico("sistema:reposicao"), true);
  assertEquals(ehSintetico("99999999-9999-9999-9999-999999999999"), false);
});

Deno.test("props ausente vira objeto vazio, nao explode", () => {
  const ev = montarEvento({ ...LINHA_SISTEMA, props: null });
  assertEquals(ev.properties.$lib, LIB_OUTBOX);
});

Deno.test("montarEvento nao muta a linha de origem", () => {
  const props = { a: 1 };
  montarEvento({ ...LINHA_SISTEMA, props });
  assertEquals(props, { a: 1 });
});

// ── classificação da resposta: o que volta para a fila e o que morre ──

Deno.test("2xx e aceite HTTP", () => {
  assertEquals(classificarResposta(200), "aceito");
  assertEquals(classificarResposta(204), "aceito");
});

Deno.test("429, 408, 5xx e falha de rede voltam para a fila", () => {
  assertEquals(classificarResposta(429), "transitorio");
  assertEquals(classificarResposta(408), "transitorio");
  assertEquals(classificarResposta(500), "transitorio");
  assertEquals(classificarResposta(503), "transitorio");
  assertEquals(classificarResposta(0), "transitorio");
});

Deno.test("401/403 e configuracao quebrada: quarentena, nao backoff", () => {
  // insistir num token errado só queima quota e mantem dado pessoal parado.
  assertEquals(classificarResposta(401), "permanente");
  assertEquals(classificarResposta(403), "permanente");
});

Deno.test("400 e 413 sao permanentes — retry repetiria o mesmo erro", () => {
  assertEquals(classificarResposta(400), "permanente");
  assertEquals(classificarResposta(413), "permanente");
});

// ── particionamento ──

Deno.test("lote pequeno sai inteiro, sem particionar", () => {
  const evs = [LINHA_SISTEMA, LINHA_TITULAR].map(montarEvento);
  assertEquals(particionar(evs).length, 1);
});

Deno.test("teto de bytes parte o lote e nao perde evento", () => {
  const evs = [LINHA_SISTEMA, LINHA_TITULAR, LINHA_SISTEMA].map(montarEvento);
  const lotes = particionar(evs, 10); // teto minusculo: forca 1 por lote
  assertEquals(lotes.length, 3);
  assertEquals(lotes.flat().length, evs.length);
});

Deno.test("evento sozinho maior que o teto ainda e enviado — sozinho", () => {
  // segurá-lo aqui o esconderia; mandando, o 413 marca ELE de quarentena em vez
  // de arrastar o lote junto.
  const lotes = particionar([montarEvento(LINHA_SISTEMA)], 1);
  assertEquals(lotes.length, 1);
  assertEquals(lotes[0].length, 1);
});

Deno.test("lista vazia nao gera lote vazio", () => {
  assertEquals(particionar([]).length, 0);
});

// ── o erro registrado não pode carregar payload ──

Deno.test("resumo de erro e truncado", () => {
  assertEquals(resumirErro(400, "x".repeat(500)).length, "HTTP 400: ".length + 200);
});
