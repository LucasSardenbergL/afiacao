import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
        key: Deno.env.get("OMIE_VENDAS_APP_KEY")!,
        secret: Deno.env.get("OMIE_VENDAS_APP_SECRET")!,
      };
    case "colacor":
      return {
        key: Deno.env.get("OMIE_COLACOR_VENDAS_APP_KEY")!,
        secret: Deno.env.get("OMIE_COLACOR_VENDAS_APP_SECRET")!,
      };
    case "afiacao":
    default:
      return {
        key: Deno.env.get("OMIE_APP_KEY")!,
        secret: Deno.env.get("OMIE_APP_SECRET")!,
      };
  }
}

async function callOmie(endpoint: string, call: string, params: Record<string, unknown>[], account = "oben") {
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
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Resposta inválida da API Omie: ${text.substring(0, 300)}`);
  }

  if (data.faultstring) {
    throw new Error(`Omie: ${data.faultstring}`);
  }

  return data;
}

interface StepResult {
  step: number;
  description: string;
  status: "success" | "error" | "warning";
  detail?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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

    const { nf_number, account = "oben" } = await req.json();
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
        const listResult = await callOmie("produtos/recebimentonfe/", "ListarRecebimentos", [{
          nPagina: pagina,
          nRegistrosPorPagina: 50,
        }], account);

        const recebimentos = listResult.recebimentos || [];
        const totalRegistros = listResult.nTotalRegistros || 0;
        console.log(`[process-nfe] Página ${pagina}: ${recebimentos.length} recebimentos, total=${totalRegistros}`);

        // Log sample for debugging
        if (pagina === 1 && recebimentos.length > 0) {
          const samples = recebimentos.slice(0, 5).map((r: any) => ({
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
      steps.push({ step: 1, description: `Buscar NF ${nf_number}`, status: "error", detail: e.message });
      return new Response(JSON.stringify({ steps, error: e.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 2 - Get full details via ConsultarRecebimento
    let itens: any[] = [];
    try {
      const consultaParams: Record<string, unknown> = { nIdReceb };
      if (cChaveNfe) consultaParams.cChaveNfe = cChaveNfe;
      
      const detail = await callOmie("produtos/recebimentonfe/", "ConsultarRecebimento", [consultaParams], account);
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
      steps.push({ step: 2, description: "Consultar detalhes da NF", status: "error", detail: e.message });
      return new Response(JSON.stringify({ steps, error: e.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 3 - Update received quantities and departments via AlterarRecebimento
    try {
      const itensEditar: any[] = [];
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
        const deptResult = await callOmie("geral/departamentos/", "ListarDepartamentos", [{
          pagina: 1,
          registros_por_pagina: 50,
        }], account);
        const deptos = deptResult.departamentos || [];
        console.log(`[process-nfe] Departamentos: ${deptos.map((d: any) => d.descricao || d.codigo).join(", ")}`);
        const opsDept = deptos.find((d: any) => 
          (d.descricao || "").toLowerCase().includes("opera") || 
          (d.codigo || "").toLowerCase().includes("opera")
        );
        if (opsDept) {
          departmentCode = opsDept.codigo;
          console.log(`[process-nfe] Departamento Operações encontrado: ${departmentCode}`);
        }
      } catch (e) {
        console.log(`[process-nfe] Erro ao listar departamentos: ${e.message}`);
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
      steps.push({ step: 3, description: "Atualizar recebimento", status: "error", detail: e.message });
      return new Response(JSON.stringify({ steps, error: e.message }), {
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
      if (e.message?.includes("já") || e.message?.includes("etapa")) {
        steps.push({ step: 4, description: "Etapa já configurada", status: "warning", detail: e.message });
      } else {
        steps.push({ step: 4, description: "Alterar etapa", status: "error", detail: e.message });
        return new Response(JSON.stringify({ steps, error: e.message }), {
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
      steps.push({ step: 5, description: "Concluir recebimento", status: "error", detail: e.message });
      return new Response(JSON.stringify({ steps, error: e.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ steps, success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
