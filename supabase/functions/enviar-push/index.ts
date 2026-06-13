// Edge `enviar-push` — entrega Web Push (VAPID) pras vendedoras.
// Chamada pelos produtores SQL (triggers de WhatsApp inbound / tarefa nova e
// cron de SLA) via pg_net com header `x-cron-secret`. Best-effort por design:
// quem dispara NUNCA depende do sucesso daqui (o badge/card é a fonte da verdade).
//
// Secrets exigidos (além dos padrão): VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:).
// A chave PÚBLICA correspondente vive em src/lib/push/vapid.ts (hardcoded, é pública).

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { authorizeCron, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:lucascoelhosardenberg@gmail.com";
// Espelho da pública de src/lib/push/vapid.ts (par gerado 2026-06-10).
const VAPID_PUBLIC_KEY =
  "BKN3yET55ssQxXVjmc_5D3ud1znzAIsOJOoYdUsElsFARyhyzQzA9WgVFtvZytJnKpigTvlqZKvoyDdwIdHGQn0";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/* ──────────────────────────────────────────────────────────────────────────
 * ESPELHO VERBATIM de src/lib/push/payload.ts (oráculo TDD no front; Deno
 * não importa do src/). Mudou lá → re-espelhar aqui.
 * ────────────────────────────────────────────────────────────────────────── */

const TITULO_MAX = 120;
const CORPO_MAX = 240;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EnvioPushValido {
  user_ids: string[];
  titulo: string;
  corpo: string;
  url: string;
  tag?: string;
}

type ResultadoValidacao =
  | { ok: true; dados: EnvioPushValido }
  | { ok: false; erro: string };

function validarEnvioPush(body: unknown): ResultadoValidacao {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!Array.isArray(b.user_ids) || b.user_ids.length === 0) {
    return { ok: false, erro: "user_ids deve ser array não-vazio" };
  }
  const userIds = [...new Set(b.user_ids.map(String))];
  if (userIds.some((id) => !UUID_RE.test(id))) {
    return { ok: false, erro: "user_ids contém valor que não é uuid" };
  }

  const titulo = typeof b.titulo === "string" ? b.titulo.trim() : "";
  if (!titulo) return { ok: false, erro: "titulo é obrigatório" };

  const corpo = typeof b.corpo === "string" ? b.corpo.trim() : "";

  const urlCrua = typeof b.url === "string" && b.url.trim() ? b.url.trim() : "/";
  if (!urlCrua.startsWith("/") || urlCrua.startsWith("//")) {
    return { ok: false, erro: "url deve ser path interno (começar com /)" };
  }

  const tag = typeof b.tag === "string" && b.tag.trim() ? b.tag.trim() : undefined;

  return {
    ok: true,
    dados: {
      user_ids: userIds,
      titulo: titulo.slice(0, TITULO_MAX),
      corpo: corpo.slice(0, CORPO_MAX),
      url: urlCrua,
      tag,
    },
  };
}

function montarNotificacao(dados: EnvioPushValido): {
  titulo: string;
  corpo: string;
  url: string;
  tag?: string;
} {
  return { titulo: dados.titulo, corpo: dados.corpo, url: dados.url, tag: dados.tag };
}

/* ────────────────────────────────────────────────────────────────────────── */

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  subscription: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Só automação (triggers/cron via x-cron-secret). Não há caminho de UI.
  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  if (!VAPID_PRIVATE_KEY) {
    console.error("[enviar-push] VAPID_PRIVATE_KEY ausente — secret não configurado");
    return json({ error: "VAPID_PRIVATE_KEY não configurada" }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const validacao = validarEnvioPush(body);
  if (!validacao.ok) return json({ error: validacao.erro }, 400);
  const dados = validacao.dados;

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: subs, error: subsErr } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, subscription")
    .in("user_id", dados.user_ids);

  if (subsErr) {
    console.error("[enviar-push] erro lendo subscriptions:", subsErr.message);
    return json({ error: subsErr.message }, 500);
  }
  if (!subs || subs.length === 0) {
    return json({ enviados: 0, falhas: 0, removidas: 0, motivo: "sem subscriptions" });
  }

  const payload = JSON.stringify(montarNotificacao(dados));
  let enviados = 0;
  let falhas = 0;
  const mortas: string[] = [];

  await Promise.all(
    (subs as SubscriptionRow[]).map(async (s) => {
      const sub = s.subscription;
      if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
        mortas.push(s.id); // linha malformada — nunca vai entregar
        return;
      }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          payload,
          { TTL: 3600 }, // cutucão de urgência: depois de 1h o badge/card já cobre
        );
        enviados++;
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          mortas.push(s.id); // subscription expirada/cancelada no push service
        } else {
          falhas++;
          console.error(`[enviar-push] falha endpoint ${s.endpoint.slice(0, 48)}…: ${status ?? err}`);
        }
      }
    }),
  );

  if (mortas.length > 0) {
    const { error: delErr } = await supabase.from("push_subscriptions").delete().in("id", mortas);
    if (delErr) console.error("[enviar-push] erro limpando subscriptions mortas:", delErr.message);
  }

  return json({ enviados, falhas, removidas: mortas.length });
});
