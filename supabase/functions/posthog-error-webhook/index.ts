// posthog-error-webhook: recebe alerta "issue created/reopened" do PostHog Error Tracking,
// valida segredo, e delega à RPC enfileirar_erro_app (dedupe + anti-tempestade + insert atômico).
// Helpers ESPELHADOS verbatim de src/lib/posthog-error/* (Deno não importa de src).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('POSTHOG_WEBHOOK_SECRET') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-posthog-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---- helpers espelhados de src/lib/posthog-error/* ----
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function stripQueryString(url: string): string {
  if (!url) return '';
  const q = url.indexOf('?'), h = url.indexOf('#');
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return url.slice(0, end);
}
const norm = (s: string | null | undefined) => (s ?? '').toString().trim() || '_';
function buildDedupeKey(p: { projectId?: string | null; issueId?: string | null; action?: string | null }): string {
  return `${norm(p.projectId)}:${norm(p.issueId)}:${norm(p.action)}`;
}
function buildRollupKey(nowIso: string): string {
  return `rollup:${Math.floor(new Date(nowIso).getTime() / (30 * 60 * 1000))}`;
}
function buildListaUrl(issueUrl: string | null | undefined): string {
  if (!issueUrl) return 'https://us.posthog.com';
  return issueUrl.replace(/\/error_tracking\/.*/, '/error_tracking');
}
interface IssueInfo {
  issueId: string | null; name: string | null; message: string | null; issueUrl: string | null;
  firstSeen: string | null; action: string | null; projectId: string | null; rota?: string | null;
}
const pickStr = (...vals: unknown[]): string | null => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return null;
};
function parsePosthogIssuePayload(raw: unknown): IssueInfo {
  const r: Record<string, unknown> = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
  const data = asObj(r.data); const issue = asObj(r.issue ?? data.issue ?? data);
  const props = asObj(r.properties);
  return {
    issueId: pickStr(issue.id, r.issue_id, issue.fingerprint, r.id),
    name: pickStr(issue.name, issue.title, issue.exception_type, r.name),
    message: pickStr(issue.description, issue.message, issue.exception_message, r.message),
    issueUrl: pickStr(issue.url, issue.link, r.url, r.issue_url),
    firstSeen: pickStr(issue.first_seen, (issue as Record<string, unknown>).firstSeen, r.first_seen),
    action: pickStr(r.action, r.event, issue.status),
    projectId: pickStr(r.project_id, asObj(r.project).id, issue.project_id),
    rota: pickStr(props['$pathname'], props['$current_url']),
  };
}
function buildErroAppAlerta(info: IssueInfo): { titulo: string; mensagem: string; metadata: Record<string, unknown> } {
  const name = (info.name ?? 'Erro desconhecido').slice(0, 200);
  const msg = (info.message ?? '').slice(0, 500);
  const rota = info.rota ? stripQueryString(info.rota).slice(0, 200) : null;
  const linhas: string[] = [];
  if (msg) linhas.push(msg);
  if (rota) linhas.push(`Rota: ${rota}`);
  if (info.issueUrl) linhas.push(`Ver no PostHog (stack + replay): ${info.issueUrl}`);
  const metadata: Record<string, unknown> = { erro: name };
  if (rota) metadata.rota = rota;
  if (info.firstSeen) metadata.primeira_vez = info.firstSeen;
  return { titulo: `Erro no app: ${name}`, mensagem: linhas.join('\n') || '(sem detalhes — ver no PostHog)', metadata };
}
// ---- fim helpers ----

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: corsHeaders });

  // auth: segredo no header, constant-time
  const provided = req.headers.get('x-posthog-webhook-secret') ?? '';
  if (!WEBHOOK_SECRET || !constantTimeEqual(provided, WEBHOOK_SECRET)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let raw: unknown = null;
  let rawText = '';
  try { rawText = await req.text(); raw = JSON.parse(rawText); } catch { raw = null; }
  console.log('[posthog-error-webhook] payload:', rawText.slice(0, 2000)); // modo descoberta

  const info = parsePosthogIssuePayload(raw);
  const nowIso = new Date().toISOString();
  const dedupeKey = buildDedupeKey({ projectId: info.projectId, issueId: info.issueId, action: info.action });
  const rollupKey = buildRollupKey(nowIso);
  const { titulo, mensagem, metadata } = buildErroAppAlerta(info);
  // lista de issues do PostHog p/ o rollup (deriva da issueUrl cortando /{uuid}, ou usa o host)
  const listaUrl = buildListaUrl(info.issueUrl);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await supabase.rpc('enfileirar_erro_app', {
    p_dedupe_key: dedupeKey,
    p_issue_id: info.issueId,
    p_action: info.action,
    p_payload_raw: rawText.slice(0, 8000),
    p_titulo: titulo,
    p_mensagem: mensagem,
    p_metadata: metadata,
    p_rollup_key: rollupKey,
    p_lista_url: listaUrl,
    p_cap: 10,
  });

  if (error) {
    console.error('[posthog-error-webhook] RPC falhou:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true, result: data }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
