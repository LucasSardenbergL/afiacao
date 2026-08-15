import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

// ── Omie NF-e (recebimento de NF-e) response types ──
interface NfeCabec {
  nIdReceb?: number;
  cNumeroNFe?: string;
  cChaveNfe?: string;
  cNome?: string;
  cRazaoSocial?: string;
  cCodigoProduto?: string;
  cIgnorarItem?: string;
  nQtdeNFe?: number;
  nFatorConversao?: number;
  nFatorConv?: number;
  nSequencia?: number;
  nValorUnitario?: number;
  nValorTotal?: number;
  nIdProduto?: number;
}

interface NfeAjustes {
  nFatorConversao?: number;
  nFatorConv?: number;
}

interface NfeItemSubObj {
  nFatorConversao?: number;
}

interface NfeItem {
  itensCabec?: NfeCabec;
  itensAjustes?: NfeAjustes;
  itensConversao?: NfeItemSubObj;
  itensNfe?: NfeItemSubObj;
  [key: string]: unknown;
}

interface OmieListarRecebimentosResponse {
  recebimentos?: Array<{ cabec?: NfeCabec }>;
  nTotalRegistros?: number;
}

interface OmieConsultarRecebimentoResponse {
  itensRecebimento?: NfeItem[];
}

interface OmieDepartamento {
  codigo?: string;
  descricao?: string;
}

interface OmieListarDepartamentosResponse {
  departamentos?: OmieDepartamento[];
}

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const OMIE_BASE = "https://app.omie.com.br/api/v1/";

function getCredentials(account: string): { key: string; secret: string } {
  switch (account) {
    case "oben":
      return {
        key: Deno.env.get("OMIE_OBEN_APP_KEY")!,
        secret: Deno.env.get("OMIE_OBEN_APP_SECRET")!,
      };
    case "colacor":
      return {
        key: Deno.env.get("OMIE_COLACOR_APP_KEY")!,
        secret: Deno.env.get("OMIE_COLACOR_APP_SECRET")!,
      };
    case "afiacao":
    default:
      return {
        key: Deno.env.get("OMIE_COLACOR_SC_APP_KEY")!,
        secret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET")!,
      };
  }
}

async function callOmie(endpoint: string, call: string, params: Record<string, unknown>[], account = "oben"): Promise<Record<string, unknown>> {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais Omie não configuradas para ${account}`);

  const body = {
    call,
    app_key: creds.key,
    app_secret: creds.secret,
    param: params,
  };

  console.log(`[callOmie] ${call} -> ${endpoint}`);

  const res = await fetch(`${OMIE_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Resposta inválida da API Omie: ${text.substring(0, 300)}`);
  }

  // `faultstring` ANTES do status (ordem canônica do #1614 — docs/agent/sync.md): o EOF do
  // contrato Omie chega às vezes acompanhado de 5xx, e classificá-lo como falha de transporte
  // apagaria a mensagem específica que o call-site usa para decidir.
  if (typeof data.faultstring === "string") {
    throw new Error(`Omie: ${data.faultstring}`);
  }

  // Sem faultstring, só um 2xx é resposta. `fetch` NÃO lança em HTTP não-2xx: um 429/5xx cujo
  // corpo parseia limpo (o `{}` de proxy/gateway) voltava daqui como resposta BOA, e cada
  // consumidor lia o campo ausente como fato do Omie — nota sem itens, sem pedido casado, sem
  // fornecedor. Site revelado ao trocar a janela fixa do gate G6 pelo escopo LÉXICO da função: o
  // `.ok` que satisfazia o detector era o `!__auth.ok` do gate de AUTORIZAÇÃO do handler, 30
  // linhas abaixo e em outra função — um objeto sem relação nenhuma com esta resposta HTTP. O
  // zero medido aqui não era "auditado", era o detector lendo o guard errado (§"O DETECTOR mente").
  if (!res.ok) {
    throw new Error(`Omie: HTTP ${res.status} em ${call}`);
  }

  // `faultcode` sem `faultstring` fecha a ordem canônica do #1614. Aqui o efeito é o pior da
  // família: os retornos de `AlterarRecebimento`/`AlterarEtapaRecebimento`/`ConcluirRecebimento`
  // são IGNORADOS pelos call-sites, então um `200 {"faultcode":"5113"}` fazia a edge responder
  // `success:true` sem nenhuma das mutações ter acontecido no ERP (achado Codex xhigh).
  if (typeof data.faultcode === "string" || typeof data.faultcode === "number") {
    throw new Error(`Omie: faultcode ${String(data.faultcode)} em ${call}`);
  }

  return data;
}

interface StepResult {
  step: number;
  description: string;
  status: "success" | "error" | "warning";
  detail?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  const __auth = await authorizeCronOrStaff(req);
  if (!__auth.ok) return __auth.response;

  // ⚠️ SONDA DE VERSÃO — antes de tudo, porque daqui pra frente a edge EFETIVA a NF-e no Omie
  // (AlterarRecebimento → AlterarEtapaRecebimento etapa 40 → ConcluirRecebimento) e não existe
  // dry_run neste código. Fica logo após o authorizeCronOrStaff e ANTES do guard `Bearer` abaixo
  // de propósito: o guard exige JWT de usuário, e é pelo SQL Editor (x-cron-secret) que a sonda é
  // invocada em produção — atrás do guard ela seria inalcançável justamente para quem precisa
  // dela. O FLUXO REAL continua exigindo os dois gates. Ver versao.ts / _shared/sonda-versao.ts.
  //
  // O corpo é consumido AQUI (req.json() só pode ser lido uma vez) e reaproveitado no fluxo real.
  let corpoBruto: unknown = {};
  try {
    corpoBruto = await req.json();
  } catch {
    corpoBruto = {};
  }
  const decisaoSonda = classificarSonda(corpoBruto);
  if (decisaoSonda.tipo === "sonda") {
    return new Response(JSON.stringify(respostaSonda(VERSAO)), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (decisaoSonda.tipo === "ambiguo") {
    return new Response(
      JSON.stringify({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO), versao: VERSAO }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const corpo: Record<string, unknown> =
    typeof corpoBruto === "object" && corpoBruto !== null && !Array.isArray(corpoBruto)
      ? corpoBruto as Record<string, unknown>
      : {};

  try {
    // ── Auth guard ──
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const supabaseAuth = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Corpo já consumido no bloco da sonda acima (req.json() é one-shot).
    const nf_number = corpo.nf_number;
    const account = typeof corpo.account === "string" && corpo.account ? corpo.account : "oben";
    if (!nf_number) {
      return new Response(JSON.stringify({ error: "nf_number é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const steps: StepResult[] = [];
    let nIdReceb: number | null = null;
    let cChaveNfe: string | null = null;
    const nfNumberClean = String(Number(nf_number)); // strip leading zeros

    console.log(`[process-nfe] Iniciando: NF="${nf_number}", clean="${nfNumberClean}", account="${account}"`);

    // STEP 1 - Find the NF using ListarRecebimentos
    try {
      let found = false;
      let pagina = 1;

      while (!found && pagina <= 30) {
        console.log(`[process-nfe] ListarRecebimentos página ${pagina}...`);
        const listResult = (await callOmie("produtos/recebimentonfe/", "ListarRecebimentos", [{
          nPagina: pagina,
          nRegistrosPorPagina: 50,
        }], account)) as unknown as OmieListarRecebimentosResponse;

        const recebimentos = listResult.recebimentos || [];
        const totalRegistros = listResult.nTotalRegistros || 0;
        console.log(`[process-nfe] Página ${pagina}: ${recebimentos.length} recebimentos, total=${totalRegistros}`);

        // Log sample for debugging
        if (pagina === 1 && recebimentos.length > 0) {
          const samples = recebimentos.slice(0, 5).map((r) => ({
            nIdReceb: r.cabec?.nIdReceb,
            cNumeroNFe: r.cabec?.cNumeroNFe,
            cNome: r.cabec?.cNome,
          }));
          console.log(`[process-nfe] Amostras: ${JSON.stringify(samples)}`);
        }

        for (const receb of recebimentos) {
          const cabec = receb.cabec || {};
          const numNfe = String(cabec.cNumeroNFe || "");
          const numNfeClean = String(Number(numNfe) || numNfe);
          
          if (numNfe === String(nf_number) || numNfeClean === nfNumberClean || numNfe === nfNumberClean) {
            nIdReceb = cabec.nIdReceb;
            cChaveNfe = cabec.cChaveNfe || null;
            const fornecedor = cabec.cNome || cabec.cRazaoSocial || "Fornecedor";
            steps.push({
              step: 1,
              description: `NF encontrada: ${fornecedor} (NF ${numNfe})`,
              status: "success",
              detail: `nIdReceb: ${nIdReceb}, chave: ${cChaveNfe ? cChaveNfe.substring(0, 20) + "..." : "N/A"}`,
            });
            found = true;
            console.log(`[process-nfe] NF encontrada! nIdReceb=${nIdReceb}`);
            break;
          }
        }

        if (!found) {
          const totalPages = Math.ceil(totalRegistros / 50);
          if (pagina >= totalPages || recebimentos.length === 0) break;
          pagina++;
        }
      }

      if (!found) {
        throw new Error(`NF ${nf_number} não encontrada no Omie (verificadas ${pagina} páginas, endpoint: produtos/recebimentonfe/)`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      steps.push({ step: 1, description: `Buscar NF ${nf_number}`, status: "error", detail: message });
      return new Response(JSON.stringify({ steps, error: message, versao: VERSAO }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 2 - Get full details via ConsultarRecebimento
    let itens: NfeItem[] = [];
    try {
      const consultaParams: Record<string, unknown> = { nIdReceb };
      if (cChaveNfe) consultaParams.cChaveNfe = cChaveNfe;

      const detail = (await callOmie("produtos/recebimentonfe/", "ConsultarRecebimento", [consultaParams], account)) as unknown as OmieConsultarRecebimentoResponse;
      itens = detail.itensRecebimento || [];
      
      console.log(`[process-nfe] ConsultarRecebimento: ${itens.length} itens`);

      // Check item associations
      let associationIssues = 0;
      const warnings: string[] = [];

      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const cabec = item.itensCabec || {};
        const nIdProduto = cabec.nIdProduto;
        const cIgnorar = cabec.cIgnorarItem;
        
        if (cIgnorar === "S") {
          warnings.push(`Item ${i + 1}: ignorado`);
          continue;
        }
        
        if (!nIdProduto || nIdProduto === 0) {
          associationIssues++;
          warnings.push(`Item ${i + 1} (${cabec.cCodigoProduto || "?"}): sem produto associado`);
        }
      }

      if (associationIssues > 0) {
        steps.push({
          step: 2,
          description: `Itens verificados: ${itens.length} itens, ${associationIssues} sem associação`,
          status: "warning",
          detail: warnings.join("; "),
        });
      } else {
        steps.push({
          step: 2,
          description: `Itens verificados: ${itens.length} itens, todos associados`,
          status: "success",
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      steps.push({ step: 2, description: "Consultar detalhes da NF", status: "error", detail: message });
      return new Response(JSON.stringify({ steps, error: message, versao: VERSAO }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 3 - Update received quantities and departments via AlterarRecebimento
    try {
      const itensEditar: Array<{
        itensIde: { nSequencia: number; cAcao: string };
        itensAjustes: { nQtdeRecebida: number };
      }> = [];
      const itemResults: string[] = [];

      // Debug: log first item structure to find conversion factor field
      if (itens.length > 0) {
        console.log(`[process-nfe] DEBUG item[0] keys: ${JSON.stringify(Object.keys(itens[0]))}`);
        console.log(`[process-nfe] DEBUG item[0].itensCabec: ${JSON.stringify(itens[0].itensCabec)}`);
        console.log(`[process-nfe] DEBUG item[0].itensAjustes: ${JSON.stringify(itens[0].itensAjustes)}`);
        if (itens[0].itensConversao) console.log(`[process-nfe] DEBUG item[0].itensConversao: ${JSON.stringify(itens[0].itensConversao)}`);
        if (itens[0].itensNfe) console.log(`[process-nfe] DEBUG item[0].itensNfe: ${JSON.stringify(itens[0].itensNfe)}`);
        // Log all sub-objects
        for (const key of Object.keys(itens[0])) {
          const val = itens[0][key];
          if (typeof val === 'object' && val !== null) {
            const strVal = JSON.stringify(val);
            if (strVal.toLowerCase().includes('fator') || strVal.toLowerCase().includes('conver')) {
              console.log(`[process-nfe] DEBUG FATOR found in item[0].${key}: ${strVal}`);
            }
          }
        }
      }

      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const cabec = item.itensCabec || {};
        const ajustes = item.itensAjustes || {};
        
        if (cabec.cIgnorarItem === "S") continue;

        const qtdeNfe = Number(cabec.nQtdeNFe || 0);
        // Search for conversion factor in all possible locations
        const fatorConversao = Number(
          cabec.nFatorConversao || 
          ajustes.nFatorConversao || 
          (item.itensConversao || {}).nFatorConversao ||
          (item.itensNfe || {}).nFatorConversao ||
          cabec.nFatorConv ||
          ajustes.nFatorConv ||
          1
        );
        const qtdRecebida = Math.round(qtdeNfe / fatorConversao);
        const codigoProduto = cabec.cCodigoProduto || `item_${i + 1}`;
        const nSequencia = cabec.nSequencia || (i + 1);

        itensEditar.push({
          itensIde: {
            nSequencia: nSequencia,
            cAcao: "EDITAR",
          },
          itensAjustes: {
            nQtdeRecebida: qtdRecebida,
          },
        });

        itemResults.push(`${codigoProduto}: NF ${qtdeNfe} / FC ${fatorConversao} = ${qtdRecebida}`);
      }

      // Find department code
      let departmentCode = "";
      try {
        const deptResult = (await callOmie("geral/departamentos/", "ListarDepartamentos", [{
          pagina: 1,
          registros_por_pagina: 50,
        }], account)) as unknown as OmieListarDepartamentosResponse;
        const deptos = deptResult.departamentos || [];
        console.log(`[process-nfe] Departamentos: ${deptos.map((d) => d.descricao || d.codigo).join(", ")}`);
        const opsDept = deptos.find((d) =>
          (d.descricao || "").toLowerCase().includes("opera") ||
          (d.codigo || "").toLowerCase().includes("opera")
        );
        if (opsDept && opsDept.codigo) {
          departmentCode = opsDept.codigo;
          console.log(`[process-nfe] Departamento Operações encontrado: ${departmentCode}`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.log(`[process-nfe] Erro ao listar departamentos: ${message}`);
      }

      // Calculate total NF value for department distribution
      let totalNfValue = 0;
      for (const item of itens) {
        const cabec = item.itensCabec || {};
        if (cabec.cIgnorarItem === "S") continue;
        const qtde = cabec.nQtdeNFe || 0;
        const valor = cabec.nValorUnitario || cabec.nValorTotal || 0;
        totalNfValue += Number(qtde) * Number(valor);
      }
      if (totalNfValue === 0) {
        // Fallback: sum nValorTotal directly
        for (const item of itens) {
          const cabec = item.itensCabec || {};
          if (cabec.cIgnorarItem === "S") continue;
          totalNfValue += Number(cabec.nValorTotal || 0);
        }
      }
      console.log(`[process-nfe] Total NF value for department: ${totalNfValue}`);

      const alterarPayload: Record<string, unknown> = {
        ide: { nIdReceb },
        itensRecebimentoEditar: itensEditar,
      };

      // Add department if found and value > 0
      if (departmentCode && totalNfValue > 0) {
        alterarPayload.departamentos = [{
          cCodDepartamento: departmentCode,
          pDepartamento: 100,
          vDepartamento: Math.round(totalNfValue * 100) / 100,
        }];
      }

      await callOmie("produtos/recebimentonfe/", "AlterarRecebimento", [alterarPayload], account);

      steps.push({
        step: 3,
        description: `Quantidades recebidas e departamento atualizados (${itensEditar.length} itens)`,
        status: "success",
        detail: itemResults.join(" | ") + (departmentCode ? ` | Depto: ${departmentCode}` : ""),
      });
    } catch (e) {
      // If alter fails, try step by step approach
      const message = e instanceof Error ? e.message : String(e);
      steps.push({ step: 3, description: "Atualizar recebimento", status: "error", detail: message });
      return new Response(JSON.stringify({ steps, error: message, versao: VERSAO }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 4 - Move to "Conferência" step (etapa)
    try {
      await callOmie("produtos/recebimentonfe/", "AlterarEtapaRecebimento", [{
        nIdReceb,
        cChaveNfe: cChaveNfe || "",
        cEtapa: "40", // Conferência / Pronto para concluir
      }], account);
      steps.push({ step: 4, description: "Etapa alterada para conferência", status: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("já") || message.includes("etapa")) {
        steps.push({ step: 4, description: "Etapa já configurada", status: "warning", detail: message });
      } else {
        steps.push({ step: 4, description: "Alterar etapa", status: "error", detail: message });
        return new Response(JSON.stringify({ steps, error: message, versao: VERSAO }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // STEP 5 - Conclude receipt
    try {
      await callOmie("produtos/recebimentonfe/", "ConcluirRecebimento", [{
        nIdReceb,
        cChaveNfe: cChaveNfe || "",
      }], account);
      steps.push({ step: 5, description: "Recebimento concluído com sucesso", status: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      steps.push({ step: 5, description: "Concluir recebimento", status: "error", detail: message });
      return new Response(JSON.stringify({ steps, error: message, versao: VERSAO }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ steps, success: true, versao: VERSAO }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message, versao: VERSAO }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
