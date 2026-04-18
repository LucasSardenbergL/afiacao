// Edge Function: omie-debug-consulta-cte
// DESCARTÁVEL — investigação do shape de CTes (modelo 57) recebidos pelo Omie.
//
// PÚBLICA (verify_jwt = false). Body:
//   { "empresa": "OBEN" | "COLACOR", "chave_nfe": "44 dígitos" }
//
// IMPORTANTE — descobertas da documentação oficial:
//   • NÃO existe endpoint /api/v1/produtos/recebimentocte/ (404).
//   • O endpoint /api/v1/produtos/cte/ é apenas EMISSOR (CTes próprios), não cobre RECEBIDOS.
//   • CTes RECEBIDOS pelo Agente Omie ficam no MESMO módulo das NFes:
//       /api/v1/produtos/recebimentonfe/  (campo cabec.cModeloNFe == "57" para CTe; "55" para NFe).
//   • Métodos compartilhados: ListarRecebimentos / ConsultarRecebimento / AlterarEtapaRecebimento.
//   • Detalhe XML: /api/v1/produtos/dfedocs/  método ObterCTe (param: nIdCTe — que é o nIdReceb do CTe).
//   • Vínculo CTe ↔ NFe transportada: NÃO há campo no JSON de cabeçalho. A relação aparece dentro do
//     XML do CTe (cXmlCte → tag <infNFe><chave> ou <infCTeNorm><infCarga><infDoc><infNFe>).
//     O JSON traz: cabec (transportadora=fornecedor), totais (valor frete), eventualmente
//     itensInfoAdic com referências; mas a chave da NFe transportada precisa ser parseada do XML.
//
// Estratégia desta função debug:
//   1. Listar TODOS recebimentos da empresa nos últimos 30 dias (filtro cModeloNFe = "57") via ListarRecebimentos.
//   2. Para cada CTe encontrado, chamar ConsultarRecebimento(nIdReceb) e capturar shape completo.
//   3. Chamar dfedocs.ObterCTe(nIdCTe = nIdReceb) para baixar XML e tentar extrair refNFe (chaves NFe transportadas).
//   4. Filtrar resultados pela chave_nfe do request: retornar apenas CTes cujo XML referencia ela.
//
// Retorno:
//   {
//     ok, empresa, chave_nfe_buscada,
//     ctes_encontrados: [
//       { nIdReceb, cChaveCTe, cNumeroNFe (=cNumCTe), dEmissaoNFe (=dhEmi), cabec, transporte,
//         infoCadastro: { cFaturado, dFat, cRecebido, dRec, cCancelada, dCanc, cEtapa },
//         transportadora: { cnpj, razao_social, nome },
//         valor_frete,
//         xml_top_keys, refNFe_extraidas: [...],
//         match_chave_nfe: boolean
//       }
//     ],
//     todos_ctes_periodo: [ { nIdReceb, cChaveCTe, transp, dEmi } ]   // resumo geral, sem filtro
//   }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RECEB_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";
const DFEDOCS_ENDPOINT = "https://app.omie.com.br/api/v1/produtos/dfedocs/";

type Empresa = "OBEN" | "COLACOR";

function getCredentials(empresa: Empresa) {
  if (empresa === "OBEN") {
    const app_key = Deno.env.get("OMIE_OBEN_APP_KEY");
    const app_secret = Deno.env.get("OMIE_OBEN_APP_SECRET");
    if (!app_key || !app_secret) throw new Error("Credenciais OBEN ausentes");
    return { app_key, app_secret };
  }
  const app_key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const app_secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!app_key || !app_secret) throw new Error("Credenciais COLACOR ausentes");
  return { app_key, app_secret };
}

async function callOmie(endpoint: string, call: string, params: any, creds: { app_key: string; app_secret: string }) {
  const body = { call, app_key: creds.app_key, app_secret: creds.app_secret, param: [params] };
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok || json?.faultstring) {
    throw new Error(`Omie ${call} ${r.status}: ${json?.faultstring || text.slice(0, 300)}`);
  }
  return json;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Extrai chaves de NFe (44 dígitos) referenciadas no XML do CTe. */
function extractNFeChavesFromCteXml(xml: string): string[] {
  if (!xml) return [];
  const set = new Set<string>();
  // <chave>44dig</chave>  /  <infNFe><chave>44dig</chave>
  const reChave = /<chave>(\d{44})<\/chave>/g;
  let m;
  while ((m = reChave.exec(xml)) !== null) set.add(m[1]);
  // Fallback: qualquer sequência isolada de 44 dígitos no XML que não seja a chave do próprio CTe
  const reAny = /(\d{44})/g;
  while ((m = reAny.exec(xml)) !== null) set.add(m[1]);
  return Array.from(set);
}

function extractTopLevelKeys(obj: any): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const empresa = String(body?.empresa ?? "OBEN").toUpperCase() as Empresa;
    const chaveNfe = body?.chave_nfe ? String(body.chave_nfe).replace(/\D/g, "") : "";
    const dias = Number(body?.dias ?? 30);

    if (chaveNfe && chaveNfe.length !== 44) {
      return new Response(
        JSON.stringify({ ok: false, error: "chave_nfe deve ter 44 dígitos" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const creds = getCredentials(empresa);

    // 1. Listar recebimentos (TODOS) do período — Omie aceita filtros via cabecalho/param.
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - dias * 86400000);
    const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

    console.log(`[debug-cte] empresa=${empresa} chave_nfe=${chaveNfe || "(none)"} periodo=${fmt(inicio)}-${fmt(hoje)}`);

    const todosCtesPeriodo: any[] = [];
    const ctesDetalhados: any[] = [];

    let pagina = 1;
    let totalPaginas = 1;
    do {
      const listResp = await callOmie(
        RECEB_ENDPOINT,
        "ListarRecebimentos",
        {
          nPagina: pagina,
          nRegistrosPorPagina: 50,
          cOrdenarPor: "CODIGO",
          dtEmissaoDe: fmt(inicio),
          dtEmissaoAte: fmt(hoje),
          cExibirDetalhes: "S",
          cEtapa: "",
        },
        creds,
      );
      totalPaginas = Number(listResp?.nTotPaginas ?? 1);
      const recebs: any[] = listResp?.recebimentos ?? listResp?.recebimentosCadastro ?? [];
      console.log(`[debug-cte] pagina=${pagina}/${totalPaginas} recebimentos=${recebs.length}`);

      for (const r of recebs) {
        const cabec = r?.cabec ?? {};
        const modelo = String(cabec?.cModeloNFe ?? "");
        if (modelo !== "57") continue; // só CTes
        todosCtesPeriodo.push({
          nIdReceb: cabec?.nIdReceb,
          cChaveCTe: cabec?.cChaveNfe,
          cNumero: cabec?.cNumeroNFe,
          dEmissao: cabec?.dEmissaoNFe,
          cEtapa: cabec?.cEtapa,
          transp_nome: cabec?.cNome,
          transp_cnpj: cabec?.cCNPJ_CPF,
          valor: cabec?.nValorNFe,
        });
      }
      pagina++;
      await sleep(1100); // rate limit
    } while (pagina <= totalPaginas && pagina <= 8); // safety cap

    console.log(`[debug-cte] total CTes (modelo 57) no periodo: ${todosCtesPeriodo.length}`);

    // 2. Para cada CTe (limita 20 para não estourar), consultar detalhe + obter XML
    const limite = Math.min(todosCtesPeriodo.length, 20);
    for (let i = 0; i < limite; i++) {
      const item = todosCtesPeriodo[i];
      const nIdReceb = item.nIdReceb;
      if (!nIdReceb) continue;

      try {
        const detalhe = await callOmie(
          RECEB_ENDPOINT,
          "ConsultarRecebimento",
          { nIdReceb },
          creds,
        );
        await sleep(1100);

        // Tentar baixar o XML via dfedocs.ObterCTe
        let xmlInfo: any = null;
        try {
          const cteDoc = await callOmie(DFEDOCS_ENDPOINT, "ObterCTe", { nIdCTe: nIdReceb }, creds);
          xmlInfo = {
            top_keys: extractTopLevelKeys(cteDoc),
            cNumCTe: cteDoc?.cNumCTe,
            nChaveCTe: cteDoc?.nChaveCTe,
            dDataEmisCTe: cteDoc?.dDataEmisCTe,
            cModeloCTe: cteDoc?.cModeloCTe,
            cLinkPortal: cteDoc?.cLinkPortal,
            cPdf: cteDoc?.cPdf,
            xml_length: cteDoc?.cXmlCTe?.length ?? 0,
            refNFe: extractNFeChavesFromCteXml(cteDoc?.cXmlCTe ?? "")
              .filter((k) => k !== cteDoc?.nChaveCTe), // remove a chave do próprio CTe
          };
          await sleep(1100);
        } catch (e) {
          console.error(`[debug-cte] ObterCTe falhou nIdReceb=${nIdReceb}:`, (e as Error).message);
          xmlInfo = { error: (e as Error).message };
        }

        const cabec = detalhe?.cabec ?? {};
        const transporte = detalhe?.transporte ?? {};
        const infoCadastro = detalhe?.infoCadastro ?? {};
        const totais = detalhe?.totais ?? {};

        const refs: string[] = xmlInfo?.refNFe ?? [];
        const matchChaveNfe = chaveNfe ? refs.includes(chaveNfe) : false;

        ctesDetalhados.push({
          nIdReceb,
          cChaveCTe: cabec?.cChaveNfe,
          cNumCTe: cabec?.cNumeroNFe,
          dEmissaoCTe: cabec?.dEmissaoNFe,
          modelo: cabec?.cModeloNFe,
          etapa: cabec?.cEtapa,
          transportadora: {
            cnpj: cabec?.cCNPJ_CPF,
            razao_social: cabec?.cRazaoSocial,
            nome: cabec?.cNome,
          },
          infoCadastro: {
            cFaturado: infoCadastro?.cFaturado,
            dFat: infoCadastro?.dFat,
            cRecebido: infoCadastro?.cRecebido,
            dRec: infoCadastro?.dRec,
            cCancelada: infoCadastro?.cCancelada,
            dCanc: infoCadastro?.dCanc,
            cAutorizado: infoCadastro?.cAutorizado,
          },
          valor_frete_cabec: cabec?.nValorNFe,
          totais_top_keys: extractTopLevelKeys(totais),
          transporte_top_keys: extractTopLevelKeys(transporte),
          detalhe_top_keys: extractTopLevelKeys(detalhe),
          xml_info: xmlInfo,
          match_chave_nfe: matchChaveNfe,
          // primeira ocorrência: payload completo do detalhe + xml truncado
          ...(i === 0 && {
            _full_detalhe_first: detalhe,
          }),
        });

        if (matchChaveNfe) {
          console.log(`[debug-cte] MATCH! CTe nIdReceb=${nIdReceb} chave=${cabec?.cChaveNfe} transporta NFe ${chaveNfe}`);
        }
      } catch (e) {
        console.error(`[debug-cte] erro consultando nIdReceb=${nIdReceb}:`, (e as Error).message);
        ctesDetalhados.push({ nIdReceb, error: (e as Error).message });
      }
    }

    const matches = ctesDetalhados.filter((c) => c.match_chave_nfe === true);

    return new Response(
      JSON.stringify({
        ok: true,
        empresa,
        chave_nfe_buscada: chaveNfe || null,
        periodo: { de: fmt(inicio), ate: fmt(hoje), dias },
        resumo: {
          total_ctes_periodo: todosCtesPeriodo.length,
          ctes_detalhados: ctesDetalhados.length,
          matches_chave_nfe: matches.length,
        },
        matches,
        ctes_detalhados: ctesDetalhados,
        todos_ctes_periodo: todosCtesPeriodo,
        notas_documentacao: {
          endpoint_listagem: RECEB_ENDPOINT,
          endpoint_detalhe_xml: DFEDOCS_ENDPOINT,
          metodo_listagem: "ListarRecebimentos (filtrar cabec.cModeloNFe == '57')",
          metodo_consulta: "ConsultarRecebimento (param: nIdReceb)",
          metodo_xml: "ObterCTe (dfedocs, param: nIdCTe = nIdReceb)",
          campo_data_emissao_cte: "infoCadastro.dEmissaoNFe (cabec) e dDataEmisCTe (dfedocs)",
          campo_data_recebimento: "infoCadastro.dRec (quando cRecebido='S')",
          vinculo_cte_nfe:
            "NÃO existe campo direto no JSON. É preciso parsear o XML do CTe (cXmlCTe via dfedocs.ObterCTe) e extrair as chaves <chave>...</chave> dentro de <infNFe>/<infCarga><infDoc>.",
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[debug-cte] fatal:", e);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
