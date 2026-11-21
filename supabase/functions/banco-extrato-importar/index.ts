// Edge `banco-extrato-importar`: HTTP fino (CORS, auth, clients). A lógica está em `processar.ts`.
// POST { storage_path, banco_conta_id } com JWT de usuário (bucket privado `banco-extratos`).
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { processar, validarCaminho } from "./processar.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const BUCKET = "banco-extratos";

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // ⚠️ SONDA DE VERSÃO — logo após o gate (que aceita x-cron-secret) e ANTES de qualquer leitura.
  let corpoBruto: unknown;
  try {
    corpoBruto = await req.json();
  } catch {
    return json({ erro: "invalid JSON" }, 400);
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ erro: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  // Fluxo real: só JWT de usuário (a RPC precisa de `enviado_por` real).
  if (auth.via !== "staff" || !auth.userId) return json({ erro: "forbidden" }, 403);

  const corpo = typeof corpoBruto === "object" && corpoBruto !== null && !Array.isArray(corpoBruto)
    ? corpoBruto as Record<string, unknown>
    : {};
  const invalido = validarCaminho(corpo.storage_path, corpo.banco_conta_id);
  if (invalido) return json({ erro: invalido }, 400);
  const storagePath = corpo.storage_path as string;
  const contaId = corpo.banco_conta_id as string;

  const url = Deno.env.get("SUPABASE_URL")!;
  const servico = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // company e estrategia vêm de banco_conta (service_role), lidas ANTES do gate de acesso.
  const { data: conta, error: erroConta } = await servico
    .from("banco_conta")
    .select("company, estrategia_chave")
    .eq("id", contaId)
    .maybeSingle();
  if (erroConta) {
    console.error("[banco-extrato-importar] leitura de banco_conta falhou", erroConta);
    return json({ erro: "erro_interno" }, 500);
  }
  if (!conta) return json({ erro: "conta_nao_encontrada" }, 404);

  // Gate de acesso à empresa com o client DO USUÁRIO (JWT) — a função avalia auth.uid().
  const usuario = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization")! } },
  });
  const { data: pode, error: erroAcesso } = await usuario.rpc("fin_user_can_access", {
    check_company: conta.company as string,
  });
  if (erroAcesso) {
    console.error("[banco-extrato-importar] fin_user_can_access falhou", erroAcesso);
    return json({ erro: "erro_interno" }, 500);
  }
  if (pode !== true) return json({ erro: "forbidden" }, 403);

  const r = await processar(
    {
      baixar: async (path) => {
        const { data, error } = await servico.storage.from(BUCKET).download(path);
        if (error || !data) throw new Error(`download falhou: ${error?.message ?? "sem dados"}`);
        return new Uint8Array(await data.arrayBuffer());
      },
      registrar: async (p) => {
        const { data, error } = await servico.rpc("banco_extrato_registrar", { p });
        if (error) throw Object.assign(new Error(error.message), { code: error.code });
        return data;
      },
      agora: () => new Date(),
    },
    {
      storage_path: storagePath,
      banco_conta_id: contaId,
      estrategia_chave: (conta.estrategia_chave as string | null) ?? null,
    },
    { id: auth.userId },
  );
  return json(r.corpo, r.status);
});
