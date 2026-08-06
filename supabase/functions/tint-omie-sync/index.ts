import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";
import { avaliarPagina, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";

interface OmieProdutoImagem {
  url_imagem?: string;
}

interface OmieProdutoCadastro {
  codigo_produto?: number | string;
  codigo_produto_integracao?: string;
  codigo?: string;
  descricao?: string;
  descricao_familia?: string;
  unidade?: string;
  ncm?: string;
  valor_unitario?: number;
  quantidade_estoque?: number;
  inativo?: string;
  marca?: string;
  modelo?: string;
  peso_bruto?: number;
  peso_liq?: number;
  imagens?: OmieProdutoImagem[];
}

interface OmieListarProdutosResponse {
  faultstring?: string;
  total_de_paginas?: number;
  produto_servico_cadastro?: OmieProdutoCadastro[];
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

const TINT_FAMILIES: Record<string, string> = {
  "bases mixmachine": "base",
  "concentrados mixmachine": "concentrado",
};

async function callOmieApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
) {
  const APP_KEY = Deno.env.get("OMIE_OBEN_APP_KEY");
  const APP_SECRET = Deno.env.get("OMIE_OBEN_APP_SECRET");
  if (!APP_KEY || !APP_SECRET) throw new Error("Credenciais Oben não configuradas");

  const body = {
    call,
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    param: [params],
  };

  console.log(`[tint-omie-sync] Chamando ${endpoint} - ${call}`);

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // O Omie sinaliza rate-limit por `faultstring` com HTTP 200 — mas um 429/5xx HTTP real não
    // passava por NENHUM ramo: o corpo parseava sem `faultstring`, `produto_servico_cadastro`
    // vinha vazio, e o laço lia isso como fim da fonte. O `completo:true` do retorno é justificado
    // por "todo caminho parcial LANÇA", e este caminho não lançava. Transitório reusa o mesmo
    // backoff do rate-limit; esgotado LANÇA (nunca vira EOF).
    if (!response.ok) {
      const corpo = (await response.text()).slice(0, 300);
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const delay = Math.min((attempt + 1) * 5 + 2, 15) * 1000;
        console.log(
          `[tint-omie-sync] HTTP ${response.status}, retry em ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Erro Omie: HTTP ${response.status} — ${corpo}`);
    }

    const result = (await response.json()) as unknown as OmieListarProdutosResponse;

    if (result.faultstring) {
      const fs = String(result.faultstring);
      const isRateLimit =
        fs.includes("Já existe uma requisição desse método") ||
        fs.includes("Consumo redundante") ||
        fs.includes("REDUNDANT") ||
        fs.includes("consumo redundante");
      if (isRateLimit && attempt < maxRetries) {
        const waitMatch = fs.match(/Aguarde (\d+) segundos/);
        const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
        const delay = Math.min(requestedDelay + 2, 15) * 1000;
        console.log(`[tint-omie-sync] Rate limit, waiting ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (isRateLimit) {
        console.log(`[tint-omie-sync] Rate limit persists after ${maxRetries} retries, returning null`);
        return null;
      }
      throw new Error(`Erro Omie: ${fs}`);
    }

    return result;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { action } = await req.json();

    if (action !== "sync_tint_products") {
      return new Response(JSON.stringify({ error: "Ação inválida" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let pagina = 1;
    let totalPaginas = 1;
    let totalSynced = 0;
    // Teto fail-fast: o catálogo oben real é ~37 páginas de 100 (3.7k produtos) — o teto
    // antigo de 20 TRUNCAVA toda run em silêncio (bases MixMachine das páginas 21+ nunca
    // sincronizadas) e ainda devolvia status "ok". 60 = real + folga; declarado acima LANÇA.
    const maxPages = 60;
    let pagesProcessed = 0;
    // Deadline ABSOLUTO (P2 do challenge Codex): 60 páginas em série, com até ~17s de espera
    // por página sob rate-limit, podem ultrapassar o teto do runtime — e o isolate morrendo
    // no meio deixa upserts parciais SEM resposta nenhuma (nem erro). Lançar antes disso
    // troca a morte muda por um erro que diz o que houve e manda rodar de novo.
    const t0 = Date.now();
    const DEADLINE_MS = 110_000;

    while (pagina <= totalPaginas) {
      if (Date.now() - t0 > DEADLINE_MS) {
        throw new Error(`deadline de ${DEADLINE_MS / 1000}s atingido na página ${pagina}/${totalPaginas} (${totalSynced} gravados) — sync incompleto, rode de novo`);
      }
      const result = await callOmieApi("geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      });

      // Rate-limit esgotado LANÇA: o break antigo fechava HTTP 200 "ok" com catálogo PARCIAL
      // e sem retomada (o operador relê o toast de sucesso e não roda de novo).
      if (!result) {
        throw new Error(`rate limit do Omie persistiu após retries na página ${pagina}/${totalPaginas} — sync interrompido, rode de novo`);
      }

      // Piso monotônico + teto fail-fast (_shared/omie-paginacao.ts): o `|| 1` por resposta
      // encolhia o teto e a varredura completava parcial como "ok".
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, maxPages);
      const produtos = result.produto_servico_cadastro || [];
      const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        throw new Error(`página ${pagina}/${totalPaginas} do ListarProdutos veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;

      const rows = produtos
        .filter((prod: OmieProdutoCadastro) => {
          if (prod.inativo === "S") return false;
          const familia = (prod.descricao_familia || "").toLowerCase().trim();
          return Object.keys(TINT_FAMILIES).some((f) => familia === f);
        })
        .map((prod: OmieProdutoCadastro) => {
          const familia = (prod.descricao_familia || "").toLowerCase().trim();
          const tintType = TINT_FAMILIES[familia] || null;
          return {
            omie_codigo_produto: prod.codigo_produto,
            omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
            codigo: prod.codigo || `PROD-${prod.codigo_produto}`,
            descricao: prod.descricao || prod.descricao_familia || "Produto sem descrição",
            unidade: prod.unidade || "UN",
            ncm: prod.ncm || null,
            valor_unitario: prod.valor_unitario || 0,
            estoque: prod.quantidade_estoque || 0,
            ativo: true,
            familia: prod.descricao_familia || null,
            imagem_url: prod.imagens?.[0]?.url_imagem || null,
            is_tintometric: true,
            tint_type: tintType,
            metadata: {
              marca: prod.marca,
              modelo: prod.modelo,
              peso_bruto: prod.peso_bruto,
              peso_liq: prod.peso_liq,
              descricao_familia: prod.descricao_familia,
            },
            account: "oben",
            updated_at: new Date().toISOString(),
          };
        });

      if (rows.length > 0) {
        const { error } = await supabase
          .from("omie_products")
          .upsert(rows, { onConflict: "omie_codigo_produto,account" });
        // Upsert com erro LANÇA: o console.error engolia a página (base/concentrado perdido)
        // e o run devolvia "ok" com total_sincronizado mentindo por baixo.
        if (error) {
          throw new Error(`upsert omie_products página ${pagina}: ${error.message}`);
        }
        totalSynced += rows.length;
      }

      console.log(
        `[tint-omie-sync] Página ${pagina}/${totalPaginas} - ${produtos.length} total, ${rows.length} tintométricos`,
      );
      pagina++;
      pagesProcessed++;
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        total_sincronizado: totalSynced,
        paginas_processadas: pagesProcessed,
        total_paginas: totalPaginas,
        // Todo caminho parcial agora LANÇA (rate-limit, anomalia, teto, upsert) — chegar aqui
        // é ter visto o fim da fonte.
        completo: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[tint-omie-sync] Erro:", error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
