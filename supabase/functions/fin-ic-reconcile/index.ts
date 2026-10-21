import { createClient } from "npm:@supabase/supabase-js@2";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { classificarFlag } from "../_shared/sonda-versao.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { fetchAll } from "../_shared/paginate.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import {
  casar,
  chaveContraparte,
  type LinhaMatch,
  STATUS_AUTOMATICOS,
  substituirMatches,
  type Titulo,
} from "./casamento.ts";
import { chamadorOmie, consultarCodigos, type ResultadoConsulta } from "./contrapartes.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// =============================================================
// Edge function: reconciliação intercompany automática
// =============================================================
// A contraparte de cada título vem do CÓDIGO Omie do cadastro (o `cnpj_cpf` do título é '' em 100%
// dos CR/CP — o Omie não o devolve nas listagens financeiras). Código → empresa do grupo: o próprio
// Omie de cada empresa, por CNPJ (`contrapartes.ts`). Regra do par: `casamento.ts`. Diário:
// docs/historico/fin-ic-reconcile-contraparte-por-codigo.md.
//
// `{ "simular": true }` roda tudo e devolve os pares SEM escrever (conferência pós-deploy).

const EMPRESAS = ["oben", "colacor", "colacor_sc"] as const;

function credenciais(empresa: string): { appKey: string; appSecret: string } | null {
  const sufixo = empresa.toUpperCase();
  const appKey = Deno.env.get(`OMIE_${sufixo}_APP_KEY`);
  const appSecret = Deno.env.get(`OMIE_${sufixo}_APP_SECRET`);
  return appKey && appSecret ? { appKey, appSecret } : null;
}

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type LinhaTitulo = {
  id: string;
  company: string;
  valor_documento: number;
  data_emissao: string | null;
  numero_documento_fiscal: string | null;
  status_titulo: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) {
    return auth.response;
  }

  // Sonda de versão (M-26; docs/agent/deploy.md): `{ probe: true }` responde a versão no ar sem tocar
  // banco. O cron manda `{}` (= disparo).
  const corpo = await req.json().catch(() => null);
  const decisaoSonda = classificarSonda(corpo);
  if (decisaoSonda.tipo === "sonda") {
    return json(respostaSonda(VERSAO), 200);
  }
  if (decisaoSonda.tipo === "ambiguo") {
    return json({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }
  const decisaoSimular = classificarFlag(corpo, "simular");
  if (decisaoSimular.tipo === "ambiguo") {
    return json({
      versao: VERSAO,
      error: `Parâmetro 'simular' com valor não reconhecido (${decisaoSimular.valor}). Use {"simular":true} ` +
        `para conferir sem escrever, ou omita a chave para executar. Recusado por segurança: ${EFEITO}.`,
    }, 400);
  }
  const simular = decisaoSimular.tipo === "sonda";

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: cnpjs, error: cnpjErr } = await supabase
      .from("company_cnpjs")
      .select("company, cnpj_normalized");
    if (cnpjErr || !cnpjs) {
      return json({ versao: VERSAO, error: `company_cnpjs: ${cnpjErr?.message ?? "sem resposta"}` }, 500);
    }
    const cnpjDe = new Map<string, string>();
    for (const c of cnpjs as Array<{ company: string; cnpj_normalized: string }>) {
      cnpjDe.set(c.company, c.cnpj_normalized);
    }
    const faltando = EMPRESAS.filter((e) => !cnpjDe.get(e));
    if (faltando.length > 0) {
      return json({ versao: VERSAO, error: `company_cnpjs sem CNPJ de: ${faltando.join(", ")}` }, 500);
    }

    // 1) Código Omie → empresa do grupo, perguntando a CADA Omie pelos CNPJs das outras.
    //    Qualquer falha aborta ANTES de tocar fin_ic_matches (mapa incompleto apagaria pares reais).
    const consultas: ResultadoConsulta[] = [];
    for (const empresa of EMPRESAS) {
      const cred = credenciais(empresa);
      if (!cred) return json({ versao: VERSAO, error: `credencial Omie ausente: ${empresa}` }, 500);
      const chamar = chamadorOmie(empresa, cred);
      for (const alvo of EMPRESAS) {
        if (alvo === empresa) continue;
        consultas.push(await consultarCodigos(chamar, { empresa, alvo, cnpjAlvo: cnpjDe.get(alvo)! }));
      }
    }
    const contraparte = new Map<string, string>();
    for (const c of consultas) {
      for (const codigo of c.codigos) contraparte.set(chaveContraparte(c.empresa, codigo), c.alvo);
    }

    // 2) Contraprova: o mapa de identidade (`omie_customer_account_map`, documento lido do mesmo
    //    Omie) não pode conhecer um cadastro do grupo que o Omie "não devolveu" — isso é filtro
    //    quebrado/parcial, e seguir apagaria os pares desse cadastro em silêncio.
    const empresaDoCnpj = new Map([...cnpjDe].map(([e, c]) => [c, e]));
    const mapa = await fetchAll<{ account: string; omie_codigo_cliente: number | null; evidence_document_normalized: string }>(
      (de, ate) =>
        supabase.from("omie_customer_account_map")
          .select("id, account, omie_codigo_cliente, evidence_document_normalized")
          .eq("source", "document")
          .in("evidence_document_normalized", [...cnpjDe.values()])
          .order("id").range(de, ate),
      "omie_customer_account_map",
    );
    const contradicoes: string[] = [];
    for (const m of mapa) {
      const alvo = empresaDoCnpj.get(m.evidence_document_normalized);
      if (!alvo || alvo === m.account || m.omie_codigo_cliente === null) continue;
      if (contraparte.get(chaveContraparte(m.account, Number(m.omie_codigo_cliente))) !== alvo) {
        contradicoes.push(`${m.account}:${m.omie_codigo_cliente}→${alvo}`);
      }
    }
    if (contradicoes.length > 0) {
      return json({
        versao: VERSAO,
        error: "o ListarClientes não devolveu cadastro(s) do grupo que o mapa de identidade conhece — " +
          "mapa de contraparte incompleto, nada gravado",
        contradicoes,
        consultas,
      }, 502);
    }

    // 3) Linhas do humano (manual/desconsiderado, ou qualquer uma já resolvida) ficam; os títulos
    //    delas saem do pool. As automáticas não resolvidas são as que serão trocadas.
    const existentes = await fetchAll<{ id: string; status: string; cr_id: string | null; cp_id: string | null; resolvido_em: string | null }>(
      (de, ate) =>
        supabase.from("fin_ic_matches").select("id, status, cr_id, cp_id, resolvido_em").order("id").range(de, ate),
      "fin_ic_matches",
    );
    const automaticos = new Set<string>(STATUS_AUTOMATICOS);
    const travados = new Set<string>();
    const idsAntigos: string[] = [];
    for (const m of existentes) {
      if (automaticos.has(m.status) && m.resolvido_em === null) {
        idsAntigos.push(m.id);
      } else {
        if (m.cr_id) travados.add(m.cr_id);
        if (m.cp_id) travados.add(m.cp_id);
      }
    }

    // 4) Só os títulos cuja contraparte é do grupo (poucos), paginados (capa de 1.000 do PostgREST).
    const crs: Titulo[] = [];
    const cps: Titulo[] = [];
    for (const empresa of EMPRESAS) {
      const codigos = consultas.filter((c) => c.empresa === empresa).flatMap((c) => c.codigos);
      if (codigos.length === 0) continue;
      const cr = await fetchAll<LinhaTitulo & { omie_codigo_cliente: number | null }>(
        (de, ate) =>
          supabase.from("fin_contas_receber")
            .select("id, company, omie_codigo_cliente, valor_documento, data_emissao, numero_documento_fiscal, status_titulo")
            .eq("company", empresa).in("omie_codigo_cliente", codigos).order("id").range(de, ate),
        `fin_contas_receber:${empresa}`,
      );
      for (const t of cr) crs.push(paraTitulo(t, t.omie_codigo_cliente));
      const cp = await fetchAll<LinhaTitulo & { omie_codigo_cliente_fornecedor: number | null }>(
        (de, ate) =>
          supabase.from("fin_contas_pagar")
            .select("id, company, omie_codigo_cliente_fornecedor, valor_documento, data_emissao, numero_documento_fiscal, status_titulo")
            .eq("company", empresa).in("omie_codigo_cliente_fornecedor", codigos).order("id").range(de, ate),
        `fin_contas_pagar:${empresa}`,
      );
      for (const t of cp) cps.push(paraTitulo(t, t.omie_codigo_cliente_fornecedor));
    }

    const linhas = casar({ crs, cps, contraparte, travados });
    const resumo = resumir(linhas, crs, cps, consultas);

    if (simular) {
      return json({ ok: true, versao: VERSAO, simulado: true, ...resumo, linhas }, 200);
    }

    const desfecho = await substituirMatches({
      inserir: (novas) => supabase.from("fin_ic_matches").insert(novas),
      apagar: (ids) => supabase.from("fin_ic_matches").delete().in("id", ids),
    }, linhas, idsAntigos);
    if (!desfecho.ok) {
      return json({
        versao: VERSAO,
        error: `fin_ic_matches (${desfecho.etapa}): ${desfecho.erro}`,
        nota: desfecho.etapa === "apagar"
          ? "linhas novas gravadas, antigas não apagadas: o DRE consolidado sai NULL até a próxima rodada"
          : "nada gravado; os matches anteriores continuam",
      }, 500);
    }
    return json({ ok: true, versao: VERSAO, simulado: false, ...resumo, apagadas: desfecho.apagadas }, 200);
  } catch (e) {
    return json({ versao: VERSAO, error: mensagemDeErro(e) ?? "falha sem mensagem" }, 502);
  }
});

function paraTitulo(t: LinhaTitulo, codigo: number | null): Titulo {
  return {
    id: t.id,
    company: t.company,
    codigo: codigo === null ? null : Number(codigo),
    valor: Number(t.valor_documento),
    data_emissao: t.data_emissao,
    nf: t.numero_documento_fiscal,
    status: t.status_titulo,
  };
}

function resumir(linhas: LinhaMatch[], crs: Titulo[], cps: Titulo[], consultas: ResultadoConsulta[]) {
  const porStatus: Record<string, number> = {};
  const paresPorMes: Record<string, { pares: number; valor: number }> = {};
  const emissaoCr = new Map(crs.map((t) => [t.id, t.data_emissao]));
  for (const l of linhas) {
    porStatus[l.status] = (porStatus[l.status] ?? 0) + 1;
    if (l.status !== "auto_matched") continue;
    const k = `${l.empresa_origem}>${l.empresa_destino}:${(emissaoCr.get(l.cr_id!) ?? "").slice(0, 7)}`;
    const acc = paresPorMes[k] ?? { pares: 0, valor: 0 };
    acc.pares += 1;
    acc.valor = Math.round((acc.valor + (l.valor_origem ?? 0)) * 100) / 100;
    paresPorMes[k] = acc;
  }
  return {
    total_matches: linhas.length,
    por_status: porStatus,
    pares_por_mes: paresPorMes,
    titulos_lidos: { cr: crs.length, cp: cps.length },
    consultas: consultas.map((c) => ({ empresa: c.empresa, alvo: c.alvo, codigos: c.codigos, descartados: c.descartados })),
  };
}
