// Edge Function: desligar-funcionario
//
// Desligamento de funcionário (docs/historico/desligamento-funcionario.md). Ação HUMANA de master:
//   1. gate canônico `authorizeCronOrStaff` (a sonda de deploy entra com x-cron-secret); a AÇÃO exige JWT humano
//      master (`authorizeMaster` de novo, depois da sonda) — cron/service_role/employee não desligam;
//   2. RPC `desligar_funcionario` com o JWT DO MASTER (o gate dela é `auth.uid()` master): revoga papel, flag de
//      equipe, commercial_roles, transfere carteira/mapa Omie/hunter/cobrança/tarefas, encerra cobertura, apaga a
//      credencial SIP e audita — tudo numa transação;
//   3. ban no Auth (admin API, service_role) — reversível com `ban_duration: "none"`;
//   4. `registrar_ban_desligamento` (service_role) grava o resultado do ban na auditoria.
// Retry é seguro: a RPC é idempotente (`ja_desligado` devolve o último id) e o ban também.
// Nada é apagado do histórico; `auth.users` nunca é deletado.

import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, authorizeMaster, corsHeaders } from "../_shared/auth.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { BAN_DURACAO, httpDoErroRpc, lerPedido, lerRespostaRpc } from "./decisao.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    const b = await req.json();
    body = b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
  } catch {
    return json({ ok: false, versao: VERSAO, mensagem: "Body JSON inválido" }, 400);
  }

  // ⚠️ SONDA DE VERSÃO — depois do gate de credencial, antes de qualquer leitura/escrita.
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO));
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ ok: false, versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const master = auth.via === "staff" ? await authorizeMaster(req) : null;
  if (!master?.ok || master.via !== "staff" || !master.userId || master.userId !== auth.userId) {
    return json({ ok: false, versao: VERSAO, mensagem: "Só um usuário master desliga funcionário." }, 403);
  }

  const pedido = lerPedido(body);
  if ("erro" in pedido) return json({ ok: false, versao: VERSAO, mensagem: pedido.erro }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const comoMaster = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await comoMaster.rpc("desligar_funcionario", {
    p_user_id: pedido.userId,
    p_novo_dono: pedido.novoDono,
    p_motivo: pedido.motivo,
  });
  if (error) {
    return json({ ok: false, versao: VERSAO, codigo: error.code ?? null, mensagem: error.message }, httpDoErroRpc(error.code));
  }
  const resposta = lerRespostaRpc(data);
  if (!resposta) return json({ ok: false, versao: VERSAO, mensagem: "Resposta inesperada da RPC de desligamento." }, 500);

  // Ban: sempre (re)aplicado — também no retry `ja_desligado`, que é como se conserta um ban que falhou.
  let ban: "aplicado" | "falhou" = "aplicado";
  let banErro: string | null = null;
  try {
    const { error: eBan } = await admin.auth.admin.updateUserById(pedido.userId, { ban_duration: BAN_DURACAO });
    if (eBan) { ban = "falhou"; banErro = eBan.message; }
  } catch (e) {
    ban = "falhou"; banErro = mensagemDeErro(e);
  }

  let auditoriaBan = true;
  if (resposta.desligamento_id) {
    const { error: eReg } = await admin.rpc("registrar_ban_desligamento", {
      p_desligamento_id: resposta.desligamento_id,
      p_ok: ban === "aplicado",
      p_erro: banErro,
    });
    if (eReg) auditoriaBan = false;
  }

  return json({
    ok: ban === "aplicado",
    versao: VERSAO,
    status: resposta.status,
    desligamento_id: resposta.desligamento_id,
    resumo: (data as Record<string, unknown>).resumo ?? null,
    ban,
    ban_erro: banErro,
    auditoria_ban: auditoriaBan,
    mensagem: ban === "aplicado"
      ? "Funcionário desligado e login bloqueado."
      : "Acesso revogado, mas o bloqueio de login FALHOU — tente de novo (é seguro repetir).",
  }, ban === "aplicado" ? 200 : 502);
});
