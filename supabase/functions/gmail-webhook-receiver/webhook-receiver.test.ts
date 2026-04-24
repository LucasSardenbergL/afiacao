// Testes do webhook gmail-webhook-receiver
// Executa contra a função já deployada no projeto Supabase.
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FN_URL = `${SUPABASE_URL}/functions/v1/gmail-webhook-receiver`;
const SECRET = Deno.env.get("GMAIL_WEBHOOK_SECRET") ?? "test-secret";

function uniqueId(prefix = "test") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function postWebhook(body: unknown, auth = `Bearer ${SECRET}`) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

Deno.test("rejeita request sem authorization", async () => {
  const { status } = await postWebhook(
    {
      fromAddress: "juliana@sayerlack.com.br",
      messageId: uniqueId(),
    },
    "",
  );
  assertEquals(status, 401);
});

Deno.test("rejeita body sem messageId", async () => {
  const { status, json } = await postWebhook({
    fromAddress: "juliana@sayerlack.com.br",
  });
  assertEquals(status, 400);
  assert(typeof json.error === "string");
});

Deno.test("rejeita remetente não mapeado", async () => {
  const { status, json } = await postWebhook({
    fromAddress: "desconhecido@example.com",
    subject: "Teste",
    messageId: uniqueId("unsupported"),
    attachments: [],
  });
  assertEquals(status, 400);
  assert(json.log_id);
});

Deno.test("detecta suspensão e cria alerta sem processar anexo", async () => {
  const { status, json } = await postWebhook({
    fromAddress: "juliana@sayerlack.com.br",
    subject: "Promoção SUSPENSA Abril 2026",
    messageId: uniqueId("suspensao"),
    receivedAt: new Date().toISOString(),
    bodyText: "A promoção foi suspensa por decisão da Sayerlack.",
    attachments: [],
  });
  assertEquals(status, 200);
  assertEquals(json.success, true);
  assertEquals(json.suspensao, true);
});

Deno.test("deduplicação: mesmo messageId retorna duplicado", async () => {
  const messageId = uniqueId("dup");
  const payload = {
    fromAddress: "juliana@sayerlack.com.br",
    subject: "Email teste dedup",
    messageId,
    receivedAt: new Date().toISOString(),
    attachments: [],
  };
  const first = await postWebhook(payload);
  assertEquals(first.status, 200);

  const second = await postWebhook(payload);
  assertEquals(second.status, 200);
  assertEquals(second.json.duplicado, true);
});
