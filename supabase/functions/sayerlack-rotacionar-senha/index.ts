// Edge `sayerlack-rotacionar-senha` — ESCRITOR ÚNICO da senha do portal Sayerlack.
//
// Por quê: a senha do usuário do portal expira no SSO TOTVS (pedido 4505 parou em 2026-11-19 por
// PASSWORD_CHANGE_REQUIRED) e vivia só no env, que nenhuma edge regrava. Agora ela vive no Vault
// (migration 20261120130000) e esta edge a troca sozinha, com a ordem que nunca deixa a conta com
// uma senha que ninguém conhece:
//   1. assume a rodada (trava no banco: uma por vez)
//   2. gera a candidata e a GRAVA no Vault, presa a esta rodada  ← antes de qualquer POST
//   3. marca `post_pode_ter_saido` e só então submete o formulário de troca TOTVS
//   4. recusa INEQUÍVOCA → descarta a candidata · senão → PROVA com login real no portal :9092
//   5. dashboard → promove (mesma transação: ativa=candidata, e-mail pendente, pedidos parados
//      por senha voltam para a fila) · qualquer outra coisa → AMBÍGUA (guarda as duas, alerta,
//      as 4 edges seguem paradas, e nenhuma nova troca é tentada)
//
// Ações (POST JSON, `authorizeCronOrStaff`):
//   { acao: "rotacionar" }  (padrão) — processa a rodada aberta, se houver. Responde 202 e trabalha em background.
//   { acao: "adotar_env" }  — saída humana: founder trocou à mão e pôs no env; a edge PROVA o login e adota.
//   { probe: true }         — sonda de versão.
//
// A senha NUNCA vai para log, diagnóstico ou alerta — só para o Vault e para o e-mail do founder.

import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { classificarPosLogin } from "../_shared/sayerlack-pos-login.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  classificarResultadoTroca,
  decidirAposTroca,
  decidirReconciliacao,
  gerarSenha,
  MAX_RECONCILIACOES,
  montarEmailSenha,
  type SinaisPosTroca,
  type TipoLogin,
} from "./logica.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SAYERLACK_PORTAL_USER = Deno.env.get("SAYERLACK_PORTAL_USER");
const SAYERLACK_PORTAL_PASS = Deno.env.get("SAYERLACK_PORTAL_PASS");
const SAYERLACK_PORTAL_URL = Deno.env.get("SAYERLACK_PORTAL_URL");
const BROWSERLESS_TOKEN = Deno.env.get("BROWSERLESS_TOKEN");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_PARA = Deno.env.get("SAYERLACK_SENHA_EMAIL_PARA");
// Formulário de troca do SSO TOTVS para onde o login do portal :9092 redireciona (medido 2026-11-19).
const TOTVS_LOGIN_URL = Deno.env.get("SAYERLACK_TOTVS_LOGIN_URL") ??
  "http://pedidos1.sayerlack.com.br:8092/totvs-login/loginForm";
const FROM_EMAIL = "Reposicao OBEN <onboarding@resend.dev>";

// ---------------------------------------------------------------------------------------------
// Browserless: TROCAR no formulário TOTVS. Só clica em "Trocar" depois de conferir que o formulário
// posta para a MESMA origem do SSO configurado. Devolve `cliqueFeito` — false prova que NÃO houve POST.
// ---------------------------------------------------------------------------------------------
const FUNCAO_TROCAR = `
export default async ({ page, context }) => {
  const { usuario, atual, nova, loginUrl } = context;
  const trace = [];
  const t0 = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const preencher = async (sel, valor) => {
    await page.click(sel);
    await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.value = ''; }, sel);
    await page.type(sel, String(valor));
  };
  const sinais = async () => page.evaluate(() => {
    const campo = document.querySelector('#txtNewPassword');
    return {
      url: location.href,
      formularioDeTrocaVisivel: !!(campo && campo.offsetParent !== null),
      texto: (document.body ? (document.body.innerText || '') : '').substring(0, 1500),
    };
  });
  try {
    const origem = new URL(loginUrl).origin;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    trace.push({ step: 'login_form', t: Date.now() - t0 });
    const abriu = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a,button,span')).find((e) => /trocar senha/i.test(e.innerText || ''));
      if (a) { a.click(); return true; }
      return false;
    });
    if (!abriu) return { data: { cliqueFeito: false, erro: 'Link "Trocar senha" nao encontrado', trace }, type: 'application/json' };
    await page.waitForSelector('#txtNewPassword', { timeout: 15000 });
    const destino = await page.evaluate(() => {
      const f = document.querySelector('#txtNewPassword') && document.querySelector('#txtNewPassword').form;
      return f ? new URL(f.getAttribute('action') || '', location.href).origin : null;
    });
    if (destino !== origem || new URL(page.url()).origin !== origem) {
      return { data: { cliqueFeito: false, erro: 'Formulario de troca fora da origem do SSO (' + destino + ')', trace }, type: 'application/json' };
    }
    await preencher('#txtUsername', usuario);
    await preencher('#txtPassword', atual);
    await preencher('#txtNewPassword', nova);
    await preencher('#txtConfirm', nova);
    trace.push({ step: 'preenchido', t: Date.now() - t0 });
    const nav = page.waitForNavigation({ timeout: 20000 }).catch(() => null);
    await page.click('#buttonChange');
    trace.push({ step: 'clicou_trocar', t: Date.now() - t0 });
    await nav;
    await sleep(1500);
    return { data: { cliqueFeito: true, sinais: await sinais(), trace }, type: 'application/json' };
  } catch (e) {
    const clicou = trace.some((x) => x.step === 'clicou_trocar');
    let s = null;
    try { s = await sinais(); } catch (_) { s = null; }
    return { data: { cliqueFeito: clicou, erro: ((e && e.message) ? String(e.message) : 'erro sem mensagem').substring(0, 300), sinais: s, trace }, type: 'application/json' };
  }
};`;

// ---------------------------------------------------------------------------------------------
// Browserless: PROVA de login no portal :9092 (mesmo critério das edges consumidoras).
// ---------------------------------------------------------------------------------------------
const FUNCAO_PROVAR_LOGIN = `
export default async ({ page, context }) => {
  const { usuario, senha, portalUrl } = context;
  const classificarPosLogin = ${classificarPosLogin.toString()};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await page.goto(portalUrl + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#user', { timeout: 10000 });
    await page.type('#user', String(usuario));
    await page.type('#password', String(senha));
    const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
    const clicou = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.innerText || '').trim().includes('Entrar'));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!clicou) return { data: { tipo: 'erro', erro: 'Botao Entrar nao encontrado' }, type: 'application/json' };
    await nav;
    await sleep(1500);
    await page.waitForFunction(
      () => document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link').length > 0,
      { timeout: 15000, polling: 250 }
    ).catch(() => null);
    const sinais = await page.evaluate(function() {
      const menu = document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link');
      const senhas = Array.from(document.querySelectorAll('input[type=password]')).filter(function(el) { return el.offsetParent !== null; });
      return { url: window.location.href, menuLinks: menu.length, camposSenha: senhas.length, titulo: document.title || '',
               texto: (document.body ? (document.body.innerText || '') : '').substring(0, 3000) };
    });
    sinais.origemEsperada = portalUrl || null;
    const r = classificarPosLogin(sinais);
    return { data: { tipo: r.tipo, url: sinais.url, menuLinks: sinais.menuLinks }, type: 'application/json' };
  } catch (e) {
    return { data: { tipo: 'erro', erro: ((e && e.message) ? String(e.message) : 'erro sem mensagem').substring(0, 300) }, type: 'application/json' };
  }
};`;

async function browserless(code: string, context: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 95_000);
  try {
    const resp = await fetch(`https://chrome.browserless.io/function?token=${BROWSERLESS_TOKEN}&timeout=90000`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({ code, context }),
    });
    if (!resp.ok) return null;
    const corpo = await resp.json().catch(() => null);
    return (corpo && typeof corpo === "object" ? (corpo.data ?? corpo) : null) as Record<string, unknown> | null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function provarLogin(senha: string): Promise<{ tipo: TipoLogin; url?: string }> {
  const r = await browserless(FUNCAO_PROVAR_LOGIN, { usuario: SAYERLACK_PORTAL_USER, senha, portalUrl: SAYERLACK_PORTAL_URL });
  const tipo = r?.tipo;
  if (tipo === "dashboard" || tipo === "troca_de_senha" || tipo === "desconhecido") {
    return { tipo, url: typeof r?.url === "string" ? r.url : undefined };
  }
  return { tipo: "erro" };
}

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

async function rpc(db: Db, fn: string, args?: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args ?? {});
  if (error) throw new Error(`${fn}: ${mensagemDeErro(error) ?? "erro sem mensagem"}`);
  return data;
}

async function alertar(db: Db, severidade: "info" | "atencao" | "urgente", titulo: string, mensagem: string, meta: Record<string, unknown>) {
  const { error } = await db.from("fornecedor_alerta").insert({
    empresa: "OBEN",
    fornecedor_nome: "RENNER SAYERLACK S/A",
    tipo: "outro",
    severidade,
    titulo,
    mensagem,
    status: "pendente_notificacao",
    metadata: { edge_function: "sayerlack-rotacionar-senha", ...meta },
  });
  if (error) console.error("[rotacionar-senha] falha ao inserir alerta", { titulo, error: error.message });
}

/** Envia a senha CONFIRMADA (versão conferida no banco). Falha no Resend: fica pendente e repete na próxima. */
async function enviarEmailPendente(db: Db): Promise<string> {
  const linhas = await rpc(db, "sayerlack_senha_portal_email_pendente");
  const linha = Array.isArray(linhas) ? linhas[0] : null;
  if (!linha?.senha) return "nada_pendente";
  if (!RESEND_API_KEY || !EMAIL_PARA) return "sem_config_email";
  const { data: rot } = await db.from("sayerlack_senha_rotacao").select("pedidos_reenfileirados").eq("id", linha.rotacao_id).maybeSingle();
  const email = montarEmailSenha(SAYERLACK_PORTAL_USER ?? "", linha.senha, (rot?.pedidos_reenfileirados ?? []).map(Number));
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM_EMAIL, to: [EMAIL_PARA], subject: email.assunto, text: email.texto }),
  }).catch(() => null);
  if (!r || !r.ok) return "falha_envio";
  await rpc(db, "sayerlack_senha_portal_email_enviado", { p_rotacao: linha.rotacao_id });
  return "enviado";
}

async function promover(db: Db, rotacaoId: string, gatilho: string): Promise<string> {
  const ids = (await rpc(db, "sayerlack_senha_portal_promover", { p_rotacao: rotacaoId })) as number[] | null;
  const email = await enviarEmailPendente(db);
  await alertar(db, "info", "Senha do portal Sayerlack trocada automaticamente",
    "A senha expirada foi trocada e confirmada com login real no portal. " +
      (email === "enviado" ? "A senha nova foi enviada por e-mail. " : "O e-mail com a senha AINDA NAO saiu (" + email + "): confira SAYERLACK_SENHA_EMAIL_PARA/RESEND_API_KEY. ") +
      ((ids ?? []).length > 0 ? "Pedidos de volta na fila: " + (ids ?? []).map((i) => "#" + i).join(", ") + "." : ""),
    { rotacao_id: rotacaoId, gatilho, email });
  return "promovida";
}

async function ambigua(db: Db, rotacaoId: string, motivo: string, diag: Record<string, unknown>, avisar: boolean) {
  await rpc(db, "sayerlack_senha_portal_marcar_ambigua", { p_rotacao: rotacaoId, p_erro: motivo, p_diagnostico: diag });
  if (avisar) {
    await alertar(db, "urgente", "Troca automatica da senha Sayerlack ficou INCERTA",
      motivo + ". As integracoes com o portal estao PAUSADAS ate resolver. ACAO: 1) tente entrar no portal com a senha " +
        "atual; se nao entrar, troque a senha a mao, 2) atualize SAYERLACK_PORTAL_PASS no Supabase Edge Functions Secrets, " +
        '3) chame a edge sayerlack-rotacionar-senha com {"acao":"adotar_env"}.',
      { rotacao_id: rotacaoId });
  }
}

/** Uma passada: e-mail pendente, depois a rodada aberta (trocar ou reconciliar). */
async function processarRodada(db: Db): Promise<Record<string, unknown>> {
  const emailAntes = await enviarEmailPendente(db).catch((e) => "erro:" + mensagemDeErro(e));
  const rodadas = await rpc(db, "sayerlack_senha_portal_assumir");
  const r = Array.isArray(rodadas) ? rodadas[0] : null;
  if (!r) return { resultado: "nada_a_fazer", email: emailAntes };
  const rotacaoId = String(r.rotacao_id);

  if (r.modo === "reconciliar") {
    if (!r.candidata) {
      await ambigua(db, rotacaoId, "Rodada ambigua sem candidata desta rodada no Vault", {}, r.tentativas_reconciliacao === 1);
      return { resultado: "ambigua_sem_candidata", rotacao_id: rotacaoId };
    }
    const prova = await provarLogin(r.candidata);
    const d = decidirReconciliacao(prova.tipo, r.tentativas_reconciliacao);
    if (d.acao === "promover") return { resultado: await promover(db, rotacaoId, "reconciliacao"), rotacao_id: rotacaoId };
    await ambigua(db, rotacaoId, d.motivo, { prova }, r.tentativas_reconciliacao >= MAX_RECONCILIACOES);
    return { resultado: "ambigua", rotacao_id: rotacaoId, motivo: d.motivo };
  }

  // modo "trocar"
  const atual: string | null = r.origem_atual === "vault" ? r.senha_atual : (SAYERLACK_PORTAL_PASS ?? null);
  if (!atual || !SAYERLACK_PORTAL_USER || !SAYERLACK_PORTAL_URL || !BROWSERLESS_TOKEN) {
    await rpc(db, "sayerlack_senha_portal_falhar", { p_rotacao: rotacaoId, p_erro: "Configuracao ausente (usuario/senha atual/URL/Browserless)", p_descartar: true });
    return { resultado: "falhou_config", rotacao_id: rotacaoId };
  }
  const nova = gerarSenha(SAYERLACK_PORTAL_USER);
  await rpc(db, "sayerlack_senha_portal_gravar_candidata", { p_rotacao: rotacaoId, p_senha: nova });
  // Daqui em diante o POST PODE ter saído: esta rodada nunca mais faz POST, e uma órfã vira ambígua.
  await rpc(db, "sayerlack_senha_portal_etapa", { p_rotacao: rotacaoId, p_etapa: "post_pode_ter_saido" });

  const troca = await browserless(FUNCAO_TROCAR, { usuario: SAYERLACK_PORTAL_USER, atual, nova, loginUrl: TOTVS_LOGIN_URL });
  const diagTroca = { cliqueFeito: troca?.cliqueFeito ?? null, erro: troca?.erro ?? null, trace: troca?.trace ?? null,
    url: (troca?.sinais as SinaisPosTroca | undefined)?.url ?? null };

  // Prova de que NÃO houve POST (o script parou antes do clique): candidata descartável com segurança.
  if (troca && troca.cliqueFeito === false) {
    const motivo = "Troca nao submetida: " + String(troca.erro ?? "sem detalhe");
    await rpc(db, "sayerlack_senha_portal_falhar", { p_rotacao: rotacaoId, p_erro: motivo, p_descartar: true });
    await alertar(db, "urgente", "Troca automatica da senha Sayerlack nao conseguiu submeter",
      motivo + ". Nada foi alterado no portal. ACAO: trocar a senha a mao, atualizar SAYERLACK_PORTAL_PASS e chamar " +
        'sayerlack-rotacionar-senha com {"acao":"adotar_env"}.', { rotacao_id: rotacaoId, ...diagTroca });
    return { resultado: "falhou_antes_do_post", rotacao_id: rotacaoId };
  }

  const resultadoTroca = classificarResultadoTroca((troca?.sinais as SinaisPosTroca | undefined) ?? null);
  if (resultadoTroca === "rejeitada") {
    const d = decidirAposTroca(resultadoTroca, null);
    const motivo = d.acao === "falhar" ? d.motivo : "recusada";
    await rpc(db, "sayerlack_senha_portal_falhar", { p_rotacao: rotacaoId, p_erro: motivo, p_descartar: true });
    await alertar(db, "urgente", "Portal Sayerlack recusou a troca automatica de senha",
      motivo + ". A senha atual segue a mesma; nao tento de novo por 6 horas. ACAO: trocar a senha a mao, atualizar " +
        'SAYERLACK_PORTAL_PASS e chamar sayerlack-rotacionar-senha com {"acao":"adotar_env"}.', { rotacao_id: rotacaoId, ...diagTroca });
    return { resultado: "falhou_recusada", rotacao_id: rotacaoId };
  }

  await rpc(db, "sayerlack_senha_portal_etapa", { p_rotacao: rotacaoId, p_etapa: "verificando", p_diagnostico: { troca: resultadoTroca, ...diagTroca } });
  const prova = await provarLogin(nova);
  const decisao = decidirAposTroca(resultadoTroca, prova.tipo);
  if (decisao.acao === "promover") return { resultado: await promover(db, rotacaoId, "troca"), rotacao_id: rotacaoId };
  const motivo = decisao.acao === "ambigua" ? decisao.motivo : "inconsistente";
  await ambigua(db, rotacaoId, motivo, { troca: resultadoTroca, prova, ...diagTroca }, true);
  return { resultado: "ambigua", rotacao_id: rotacaoId };
}

async function adotarEnv(db: Db): Promise<{ status: number; corpo: Record<string, unknown> }> {
  if (!SAYERLACK_PORTAL_PASS || !SAYERLACK_PORTAL_USER || !SAYERLACK_PORTAL_URL || !BROWSERLESS_TOKEN) {
    return { status: 500, corpo: { ok: false, motivo: "Configuracao ausente (SAYERLACK_PORTAL_PASS/USER/URL/BROWSERLESS_TOKEN)" } };
  }
  const prova = await provarLogin(SAYERLACK_PORTAL_PASS);
  if (prova.tipo !== "dashboard") {
    return { status: 409, corpo: { ok: false, motivo: "A senha do env nao chegou ao dashboard do portal (" + prova.tipo + "): nada foi adotado" } };
  }
  await rpc(db, "sayerlack_senha_portal_adotar", { p_senha: SAYERLACK_PORTAL_PASS, p_origem: "env" });
  return { status: 200, corpo: { ok: true, resultado: "adotada", mensagem: "Senha do env provada no portal e adotada; as integracoes voltaram" } };
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const corpo: Record<string, unknown> = await req.json().catch(() => ({}));
  const sonda = classificarSonda(corpo);
  if (sonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (sonda.tipo === "ambiguo") return json({ versao: VERSAO, error: erroSondaAmbigua(sonda.valor, EFEITO) }, 400);

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, motivo: "SUPABASE_URL/SERVICE_ROLE ausentes" }, 500);
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const acao = typeof corpo.acao === "string" ? corpo.acao : "rotacionar";

  try {
    if (acao === "adotar_env") {
      const r = await adotarEnv(db);
      return json({ versao: VERSAO, ...r.corpo }, r.status);
    }
    if (acao !== "rotacionar") return json({ ok: false, motivo: "acao desconhecida: " + acao }, 400);

    const trabalho = processarRodada(db).then(
      (r) => console.log("[rotacionar-senha]", JSON.stringify(r)),
      (e) => console.error("[rotacionar-senha] erro", mensagemDeErro(e)),
    );
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) {
      rt.waitUntil(trabalho);
      return json({ versao: VERSAO, ok: true, aceito: true }, 202);
    }
    await trabalho;
    return json({ versao: VERSAO, ok: true, aceito: true });
  } catch (e) {
    return json({ versao: VERSAO, ok: false, motivo: mensagemDeErro(e) }, 500);
  }
});
