// dispatch-notifications: processa fornecedor_alerta pendente_notificacao
// Envia email via Gmail API + cria evento no Google Calendar via OAuth 2.0 (refresh token).
// Sequencial: NUNCA processa alertas em paralelo.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
const CLIENT_SECRET = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
const REFRESH_TOKEN = Deno.env.get('GOOGLE_OAUTH_REFRESH_TOKEN');
const EMAIL_TO = Deno.env.get('NOTIFICATION_EMAIL_TO');
const EMAIL_FROM = Deno.env.get('NOTIFICATION_EMAIL_FROM');

const TZ = 'America/Sao_Paulo';

type Severidade = 'info' | 'atencao' | 'urgente';

interface AlertaRow {
  id: number;
  empresa: string;
  fornecedor_nome: string | null;
  tipo: string;
  severidade: Severidade;
  titulo: string;
  mensagem: string | null;
  campanha_id: number | null;
  aumento_id: number | null;
  data_evento: string | null;
  duracao_minutos: number | null;
  status: string;
  tentativas: number | null;
  metadata: Record<string, unknown> | null;
  criado_em: string;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateBr(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: TZ });
  } catch {
    return iso;
  }
}

function subjectFor(sev: Severidade, titulo: string): string {
  const tituloT = truncate(titulo, 200);
  if (sev === 'urgente') return `[Afiação 🚨] ${tituloT}`;
  if (sev === 'atencao') return `[Afiação ⚠️] ${tituloT}`;
  return `[Afiação] ${tituloT}`;
}

function buildHtmlBody(a: AlertaRow): string {
  const partes: string[] = [];
  partes.push(`<h2>${escapeHtml(a.titulo)}</h2>`);
  partes.push(
    `<p><strong>Empresa:</strong> ${escapeHtml(a.empresa)} | ` +
    `<strong>Tipo:</strong> ${escapeHtml(a.tipo)} | ` +
    `<strong>Severidade:</strong> ${escapeHtml(a.severidade)}</p>`,
  );
  if (a.fornecedor_nome) {
    partes.push(`<p><strong>Fornecedor:</strong> ${escapeHtml(a.fornecedor_nome)}</p>`);
  }
  partes.push(`<p>${escapeHtml(a.mensagem || '(sem mensagem)').replace(/\n/g, '<br/>')}</p>`);

  if (a.data_evento) {
    partes.push(`<p><strong>Evento agendado:</strong> ${escapeHtml(formatDateBr(a.data_evento))}</p>`);
  }

  if (a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata) && Object.keys(a.metadata).length > 0) {
    const items = Object.entries(a.metadata)
      .map(
        ([k, v]) =>
          `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(
            typeof v === 'object' ? JSON.stringify(v) : String(v),
          )}</li>`,
      )
      .join('');
    partes.push(`<ul>${items}</ul>`);
  }

  if (a.campanha_id || a.aumento_id) {
    const refs: string[] = [];
    if (a.campanha_id) refs.push(`campanha=${a.campanha_id}`);
    if (a.aumento_id) refs.push(`aumento=${a.aumento_id}`);
    partes.push(`<p><small>Referência: ${escapeHtml(refs.join(' '))}</small></p>`);
  }

  const nowBr = new Date().toLocaleString('pt-BR', { timeZone: TZ });
  partes.push(`<hr/><small>Sistema Afiação · ${escapeHtml(nowBr)} · Alerta ID ${a.id}</small>`);
  return partes.join('');
}

function buildRfc2822(from: string, to: string, subject: string, html: string): string {
  // Subject codificado em UTF-8 (RFC 2047) por causa de acentos e emojis
  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\r\n');
}

async function getAccessToken(): Promise<
  { ok: true; token: string } | { ok: false; status: number; error: string; revoked: boolean }
> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
    refresh_token: REFRESH_TOKEN!,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    let revoked = false;
    try {
      const j = JSON.parse(text);
      revoked = j?.error === 'invalid_grant';
    } catch { /* ignore */ }
    if (revoked) {
      console.error('[dispatch-notifications] CRÍTICO: Refresh token revogado — regenerar via OAuth Playground');
    }
    return { ok: false, status: res.status, error: text, revoked };
  }
  const json = JSON.parse(text);
  return { ok: true, token: json.access_token as string };
}

async function sendGmail(
  accessToken: string,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<string> {
  const raw = base64Url(buildRfc2822(from, to, subject, html));
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${text}`);
  const json = JSON.parse(text);
  return json.id as string;
}

async function createCalendarEvent(accessToken: string, alerta: AlertaRow): Promise<string> {
  const startDt = new Date(alerta.data_evento!);
  if (startDt.getTime() < Date.now()) {
    console.warn(
      `[dispatch-notifications] Alerta ${alerta.id}: data_evento no passado (${alerta.data_evento}), criando assim mesmo.`,
    );
  }
  const dur = alerta.duracao_minutos ?? 30;
  const endDt = new Date(startDt.getTime() + dur * 60_000);

  const summary = `[Afiação] ${truncate(alerta.titulo, 200 - 11)}`; // "[Afiação] " ~= 11 chars
  const description =
    `${alerta.mensagem ?? ''}\n\n` +
    `Empresa: ${alerta.empresa}\n` +
    `Tipo: ${alerta.tipo}\n` +
    `Severidade: ${alerta.severidade}\n` +
    `Alerta ID: ${alerta.id}`;

  const payload = {
    summary,
    description,
    start: { dateTime: startDt.toISOString(), timeZone: TZ },
    end: { dateTime: endDt.toISOString(), timeZone: TZ },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 1440 },
      ],
    },
  };

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${text}`);
  const json = JSON.parse(text);
  return json.id as string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const startedAt = new Date().toISOString();

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    const msg = 'Faltam GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN no env';
    console.error(`[dispatch-notifications] ${msg}`);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!EMAIL_TO) {
    const msg = 'NOTIFICATION_EMAIL_TO não configurado — abortando dispatch';
    console.error(`[dispatch-notifications] ${msg}`);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const from = EMAIL_FROM ?? EMAIL_TO;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 1. Buscar alertas pendentes
  const { data: alertas, error: queryError } = await supabase
    .from('fornecedor_alerta')
    .select(
      'id, empresa, fornecedor_nome, tipo, severidade, titulo, mensagem, campanha_id, aumento_id, data_evento, duracao_minutos, status, tentativas, metadata, criado_em',
    )
    .eq('status', 'pendente_notificacao')
    .lt('tentativas', 3)
    .order('criado_em', { ascending: true })
    .limit(50);

  if (queryError) {
    console.error('[dispatch-notifications] Erro ao buscar alertas:', queryError);
    return new Response(JSON.stringify({ error: queryError.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  console.log(`[dispatch-notifications] Início ${startedAt} — encontrados: ${alertas?.length ?? 0}`);

  if (!alertas || alertas.length === 0) {
    return new Response(JSON.stringify({ processados: 0 }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 2. Obter access token
  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    const msg = tokenResult.revoked
      ? 'Refresh token revogado — regenerar via OAuth Playground'
      : `Falha ao obter access token: ${tokenResult.error}`;
    return new Response(JSON.stringify({ error: msg, revoked: tokenResult.revoked }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const accessToken = tokenResult.token;

  // 3. Processar SEQUENCIALMENTE
  const detalhes: Array<{
    alerta_id: number;
    empresa: string;
    tipo: string;
    status: string;
    erro: string | null;
  }> = [];
  let sucesso = 0;
  let falhas = 0;

  for (const a of alertas as AlertaRow[]) {
    try {
      const subject = subjectFor(a.severidade, a.titulo);
      const html = buildHtmlBody(a);

      const gmailId = await sendGmail(accessToken, from, EMAIL_TO!, subject, html);

      let calendarEventoId: string | null = null;
      if (a.data_evento) {
        calendarEventoId = await createCalendarEvent(accessToken, a);
      }

      const nowIso = new Date().toISOString();
      const { error: updErr } = await supabase
        .from('fornecedor_alerta')
        .update({
          status: 'notificado',
          gmail_message_id: gmailId,
          calendar_evento_id: calendarEventoId,
          email_enviado: true,
          email_enviado_em: nowIso,
          notificado_em: nowIso,
          erro_notificacao: null,
        })
        .eq('id', a.id);

      if (updErr) throw new Error(`update DB: ${updErr.message}`);

      sucesso++;
      detalhes.push({ alerta_id: a.id, empresa: a.empresa, tipo: a.tipo, status: 'notificado', erro: null });
      console.log(
        `[dispatch-notifications] alerta ${a.id} → notificado (gmail=${gmailId}, calendar=${calendarEventoId ?? 'n/a'})`,
      );
    } catch (err) {
      const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const novasTentativas = (a.tentativas ?? 0) + 1;
      const novoStatus = novasTentativas >= 3 ? 'falha_notificacao' : 'pendente_notificacao';

      const { error: updErr } = await supabase
        .from('fornecedor_alerta')
        .update({
          tentativas: novasTentativas,
          status: novoStatus,
          erro_notificacao: errMsg,
        })
        .eq('id', a.id);

      if (updErr) {
        console.error(`[dispatch-notifications] alerta ${a.id} → falha ao atualizar tentativa:`, updErr);
      }

      falhas++;
      detalhes.push({ alerta_id: a.id, empresa: a.empresa, tipo: a.tipo, status: novoStatus, erro: errMsg });
      console.error(
        `[dispatch-notifications] alerta ${a.id} → ${novoStatus} (tentativa ${novasTentativas}/3): ${errMsg}`,
      );
    }
  }

  const processados = alertas.length;
  console.log(
    `[dispatch-notifications] Sumário: processados=${processados} sucesso=${sucesso} falhas=${falhas}`,
  );

  return new Response(JSON.stringify({ processados, sucesso, falhas, detalhes }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
