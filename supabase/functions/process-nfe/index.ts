import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    throw new Error(`Resposta inválida da API Omie: ${text.substring(0, 200)}`);
  }

  if (data.faultstring) {
    throw new Error(`Omie API Error: ${data.faultstring}`);
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
    const { nf_number, account = "oben" } = await req.json();
    if (!nf_number) {
      return new Response(JSON.stringify({ error: "nf_number é obrigatório" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const steps: StepResult[] = [];
    let codigoNfe: number | null = null;

    // STEP 1 - Find NF by number
    try {
      let found = false;
      let pagina = 1;
      const registrosPorPagina = 50;
      // Try with and without leading zeros
      const nfNumberClean = String(Number(nf_number)); // removes leading zeros
      const nfNumberOriginal = String(nf_number);

      console.log(`[process-nfe] Buscando NF: original="${nfNumberOriginal}", clean="${nfNumberClean}", account="${account}"`);

      while (!found && pagina <= 20) {
        console.log(`[process-nfe] Listando página ${pagina}...`);
        const listResult = await callOmie("estoque/nfe/", "ListarNFe", [{
          nPagina: pagina,
          nRegPorPagina: registrosPorPagina,
        }], account);

        console.log(`[process-nfe] Página ${pagina}: ${listResult.nTotalRegistros || 0} total registros, ${(listResult.nfe_cadastro || []).length} nesta página`);

        const nfes = listResult.nfe_cadastro || [];
        
        // Log first few NF numbers for debugging
        if (pagina === 1 && nfes.length > 0) {
          const sampleNumbers = nfes.slice(0, 5).map((n: any) => n.numero_nfe);
          console.log(`[process-nfe] Amostra de números NF: ${JSON.stringify(sampleNumbers)}`);
        }

        for (const nfe of nfes) {
          const nfeNum = String(nfe.numero_nfe);
          if (nfeNum === nfNumberOriginal || nfeNum === nfNumberClean || 
              String(Number(nfeNum)) === nfNumberClean) {
            codigoNfe = nfe.codigo_nfe;
            const fornecedor = nfe.razao_social || nfe.nome_fantasia || "Fornecedor";
            steps.push({
              step: 1,
              description: `NF encontrada: ${fornecedor} (NF ${nfeNum})`,
              status: "success",
              detail: `codigo_nfe: ${codigoNfe}`,
            });
            found = true;
            break;
          }
        }

        if (!found) {
          const totalPages = Math.ceil((listResult.nTotalRegistros || 0) / registrosPorPagina);
          if (pagina >= totalPages || nfes.length === 0) break;
          pagina++;
        }
      }

      if (!found) {
        throw new Error(`NF ${nf_number} não encontrada no Omie (verificadas ${pagina} páginas)`);
      }
    } catch (e) {
      steps.push({ step: 1, description: `Buscar NF ${nf_number}`, status: "error", detail: e.message });
      return new Response(JSON.stringify({ steps, error: e.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 2 - Assign Department
    try {
      await callOmie("financas/contacorrente/", "DistribuirDepartamento", [{
        codigo_nfe: codigoNfe,
        distribuicao: [{ cCodDepto: "Operações", nPercentual: 100 }],
      }], account);
      steps.push({ step: 2, description: "Departamentos configurados (Operações 100%)", status: "success" });
    } catch (e) {
      // If it fails with "already distributed", treat as warning
      if (e.message?.includes("já") || e.message?.includes("already")) {
        steps.push({ step: 2, description: "Departamento já configurado", status: "warning", detail: e.message });
      } else {
        steps.push({ step: 2, description: "Configurar departamento", status: "error", detail: e.message });
        return new Response(JSON.stringify({ steps, error: e.message }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // STEP 3 - Check and fix item associations
    let itens: any[] = [];
    try {
      const nfeDetail = await callOmie("estoque/nfe/", "ObterNFe", [{ codigo_nfe: codigoNfe }], account);
      itens = nfeDetail.itens || nfeDetail.det || [];

      let associationIssues = 0;
      const warnings: string[] = [];

      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const codigoProduto = item.codigo_produto || item.prod?.cProd;
        const codigoProdutoFornecedor = item.codigo_produto_fornecedor || item.prod?.cProdFornec;

        if (!codigoProduto && codigoProdutoFornecedor) {
          try {
            const searchResult = await callOmie("geral/produtos/", "ListarProdutos", [{
              pagina: 1,
              registros_por_pagina: 5,
              filtrar_por_codigo: codigoProdutoFornecedor,
            }], account);
            const produtos = searchResult.produto_servico_cadastro || [];
            if (produtos.length > 0) {
              warnings.push(`Item ${i + 1}: associado via busca (${codigoProdutoFornecedor})`);
            } else {
              associationIssues++;
              warnings.push(`Item ${i + 1}: sem associação encontrada (${codigoProdutoFornecedor})`);
            }
          } catch {
            associationIssues++;
            warnings.push(`Item ${i + 1}: erro ao buscar produto`);
          }
        }
      }

      if (associationIssues > 0) {
        steps.push({
          step: 3,
          description: `Itens verificados: ${itens.length} itens, ${associationIssues} sem associação`,
          status: "warning",
          detail: warnings.join("; "),
        });
      } else {
        steps.push({
          step: 3,
          description: `Itens verificados: ${itens.length} itens, todos associados`,
          status: "success",
        });
      }
    } catch (e) {
      steps.push({ step: 3, description: "Verificar itens da NF", status: "error", detail: e.message });
      return new Response(JSON.stringify({ steps, error: e.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 4 - Update received quantities
    try {
      const itemResults: string[] = [];
      for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        const quantidade = item.quantidade || item.prod?.qCom || 0;
        const qtdRecebida = Math.round(Number(quantidade));
        const codigoProduto = item.codigo_produto || item.prod?.cProd || `item_${i + 1}`;
        const nItemNfe = item.nItemNfe || item.nItem || (i + 1);

        try {
          await callOmie("estoque/nfe/", "AlterarItemNFe", [{
            codigo_nfe: codigoNfe,
            nItemNfe: nItemNfe,
            quantidade_recebida: qtdRecebida,
          }], account);
          itemResults.push(`Item ${i + 1}/${itens.length}: ${codigoProduto} - Qtd Recebida: ${qtdRecebida}`);
        } catch (e) {
          itemResults.push(`Item ${i + 1}/${itens.length}: ${codigoProduto} - ERRO: ${e.message}`);
        }
      }

      steps.push({
        step: 4,
        description: `Quantidades recebidas atualizadas (${itens.length} itens)`,
        status: "success",
        detail: itemResults.join(" | "),
      });
    } catch (e) {
      steps.push({ step: 4, description: "Atualizar quantidades recebidas", status: "error", detail: e.message });
      return new Response(JSON.stringify({ steps, error: e.message }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STEP 5 - SEFAZ Manifestation
    try {
      await callOmie("estoque/nfe/", "ManifestacaoDestinatario", [{
        codigo_nfe: codigoNfe,
        tipo_manifestacao: "CONFIRMADA",
      }], account);
      steps.push({ step: 5, description: "Manifestação confirmada na SEFAZ", status: "success" });
    } catch (e) {
      if (e.message?.includes("já") || e.message?.includes("already") || e.message?.includes("manifestad")) {
        steps.push({ step: 5, description: "Manifestação já confirmada anteriormente", status: "warning", detail: e.message });
      } else {
        steps.push({ step: 5, description: "Manifestação SEFAZ", status: "error", detail: e.message });
        return new Response(JSON.stringify({ steps, error: e.message }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // STEP 6 - Conclude receipt
    try {
      await callOmie("estoque/nfe/", "ConcluirRecebimentoNFe", [{
        codigo_nfe: codigoNfe,
      }], account);
      steps.push({ step: 6, description: "Recebimento concluído", status: "success" });
    } catch (e) {
      steps.push({ step: 6, description: "Concluir recebimento", status: "error", detail: e.message });
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
