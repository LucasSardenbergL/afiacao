import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCron, corsHeaders } from "../_shared/auth.ts";
import { avaliarPagina, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { fetchAll } from "../_shared/paginate.ts";
import {
  avaliarCompletudeCatalogo,
  codigoValido,
  type CompletudeListagem,
  type ConjuntoAnterior,
  ENTITY_AUSENTES,
  planejarInativacao,
} from "./ausentes.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
const PAGE_SIZE = 100;
// Teto anti-runaway do ListarProdutos (espelha MAX_PAGINAS_PRODUTOS de sync-reprocess/products-lote.ts):
// 500 × 100 = 50k produtos >> catálogo real (~4.3k colacor, ~3.7k oben).
const MAX_PAGINAS_PRODUTOS = 500;

type OmieAccount = "vendas" | "colacor_vendas";

// Espelho VERBATIM de src/lib/reposicao/tipo-produto.ts (Deno não importa de src/).
// Normaliza o tipo fiscal do Omie (tipoItem/SPED) ao código canônico de 2 dígitos
// ('04'=Produto Acabado/fabricado, '00'=Revenda) ou null. Rejeita 'K' (Kit) e ruído.
// money-path: se mudar aqui, mudar lá. Ver spec 2026-06-04.
function normalizeTipoProduto(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  return s.padStart(2, "0");
}

function getCredentials(account: OmieAccount) {
  if (account === "vendas") {
    return {
      key: Deno.env.get("OMIE_OBEN_APP_KEY"),
      secret: Deno.env.get("OMIE_OBEN_APP_SECRET"),
      label: "oben",
    };
  }
  return {
    key: Deno.env.get("OMIE_COLACOR_APP_KEY"),
    secret: Deno.env.get("OMIE_COLACOR_APP_SECRET"),
    label: "colacor",
  };
}

async function callOmie(
  account: OmieAccount,
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
) {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) {
    throw new Error(`Credenciais Omie (${account}) não configuradas`);
  }
  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };
  const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // HTTP não-2xx LANÇA antes de o corpo virar payload. Sem isto, um 429/5xx cujo corpo parseia
  // SEM `faultstring` (o `{}` de proxy/gateway) devolvia objeto sem total_de_paginas e sem
  // produtos — que o laço lê como página vazia no fim declarado (EOF) e o `sync_state
  // status:'complete'` carimba o catálogo PARCIAL como retrato bom. Os guards de paginação
  // não alcançam o que o wrapper já entregou como resposta boa.
  if (!res.ok) {
    throw new Error(`Omie (${account}) HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const result = await res.json();
  if (result.faultstring) throw new Error(`Omie (${account}): ${result.faultstring}`);
  return result;
}

// Invalida a confirmação do próximo run (codigos null) e registra o motivo. Chamado quando a etapa
// de ausentes falha E quando a conta inteira aborta no laço: um abort deixava o conjunto ANTERIOR
// elegível — ausente → reaparece numa varredura que aborta → ausente de novo seria "confirmado"
// sem que as duas ausências fossem consecutivas (Codex no desenho, 2026-10-12).
async function invalidarAusentes(db: SupabaseClient, acctValue: string, motivo: string) {
  const agora = new Date().toISOString();
  const { error } = await db.from("sync_state").upsert(
    {
      entity_type: ENTITY_AUSENTES,
      account: acctValue,
      status: "erro",
      error_message: motivo.slice(0, 500),
      total_synced: 0,
      last_sync_at: agora,
      updated_at: agora,
      metadata: { codigos: null, run_at: null },
    },
    { onConflict: "entity_type,account" },
  );
  if (error) console.error(`[metadados ${acctValue}] invalidação do conjunto de ausentes falhou:`, error.message);
}

// Inativa quem SUMIU do cadastro do Omie — regra pura e guardas em ausentes.ts. Só roda depois do
// upsert do catálogo inteiro; lê o conjunto de ausentes do run anterior na linha DEDICADA
// sync_state(ENTITY_AUSENTES) — escritor único, esta edge — e inativa só a interseção. Nunca DELETE
// (pedidos referenciam o produto); o upsert do próximo run reativa quem reaparecer na listagem.
// Qualquer falha de leitura LANÇA antes de inativar; o caller isola o erro (o sync já gravou).
async function inativarAusentes(
  db: SupabaseClient,
  acctValue: string,
  completude: CompletudeListagem,
  listados: ReadonlySet<number>,
  inicioVarredura: string,
) {
  const agora = new Date();
  const { data: linhaAnterior, error: erroAnterior } = await db
    .from("sync_state")
    .select("metadata")
    .eq("entity_type", ENTITY_AUSENTES)
    .eq("account", acctValue)
    .maybeSingle();
  if (erroAnterior) throw new Error(`leitura do conjunto anterior de ausentes: ${erroAnterior.message}`);
  const anterior = (linhaAnterior?.metadata ?? null) as ConjuntoAnterior | null;

  // Só lê os ativos se a listagem é completa — incompleta não decide nada (economiza a leitura).
  const ativosLocais = completude.completa
    ? (await fetchAll<{ omie_codigo_produto: number }>(
      (f, t) =>
        db
          .from("omie_products")
          .select("omie_codigo_produto")
          .eq("account", acctValue)
          .eq("ativo", true)
          .order("omie_codigo_produto", { ascending: true })
          .range(f, t),
      `omie_products:ativos:${acctValue}`,
    )).map((r) => r.omie_codigo_produto)
    : [];

  const plano = planejarInativacao({ completude, listados, ativosLocais, anterior, agoraMs: agora.getTime() });

  const inativados: number[] = [];
  const CHUNK = 200;
  for (let i = 0; i < plano.aInativar.length; i += CHUNK) {
    const lote = plano.aInativar.slice(i, i + CHUNK);
    // `.eq("ativo", true)`: só vira false quem ainda está ativo (o trigger de reposição dispara
    // uma vez). `.lt("updated_at", inicioVarredura)`: CAS — linha que QUALQUER writer tocou depois
    // que a varredura começou (outro sync viu o produto, alguém o reativou) fica de fora; o ausente
    // de verdade está congelado (os 4 de 2026-10 tinham updated_at parado há 10 dias). O `.select`
    // devolve o que de fato mudou — o registro conta o efeito, não a intenção.
    const { data, error } = await db
      .from("omie_products")
      .update({ ativo: false })
      .eq("account", acctValue)
      .eq("ativo", true)
      .lt("updated_at", inicioVarredura)
      .in("omie_codigo_produto", lote)
      .select("omie_codigo_produto");
    if (error) throw new Error(`inativação de ausentes (lote ${i / CHUNK + 1}): ${error.message}`);
    for (const r of data ?? []) inativados.push(Number(r.omie_codigo_produto));
  }

  const { error: erroRegistro } = await db.from("sync_state").upsert(
    {
      entity_type: ENTITY_AUSENTES,
      account: acctValue,
      status: plano.status,
      error_message: plano.motivo,
      total_synced: inativados.length,
      last_sync_at: agora.toISOString(),
      updated_at: agora.toISOString(),
      metadata: {
        // `codigos` + `run_at` = o que o PRÓXIMO run usa para confirmar; null invalida a confirmação.
        codigos: plano.conjuntoNovo,
        run_at: plano.conjuntoNovo ? agora.toISOString() : null,
        ausentes: plano.ausentes.length,
        ativos_locais: ativosLocais.length,
        inativados,
      },
    },
    { onConflict: "entity_type,account" },
  );
  // LANÇA (não só loga): sem o conjunto NOVO gravado, o de ONTEM seguiria elegível — X reapareceu
  // hoje, o registro falhou, um retry minutos depois omite X por deslize e o confirma com o conjunto
  // velho (o CAS não pega: o updated_at de X é anterior ao retry). O catch do caller invalida.
  // Achado do Codex no adversarial (2026-10-12). A inativação deste run, se houve, já valeu.
  if (erroRegistro) {
    throw new Error(`registro do conjunto de ausentes (inativados=${inativados.length}): ${erroRegistro.message}`);
  }

  console.log(
    `[metadados ${acctValue}] ausentes: status=${plano.status} ausentes=${plano.ausentes.length} inativados=${inativados.length}${plano.motivo ? ` motivo="${plano.motivo}"` : ""}`,
  );
  return { status: plano.status, ausentes: plano.ausentes.length, inativados, motivo: plano.motivo };
}

async function syncMetadadosAccount(
  db: SupabaseClient,
  account: OmieAccount,
) {
  const acctValue = getCredentials(account).label;
  let pagina = 1;
  let totalPaginas = 1;
  let totalUpserted = 0;
  let totalInativos = 0;
  let typedCount = 0;   // produtos com tipo_produto classificado (não-null)
  let tipo04Count = 0;  // produtos classificados como Produto Acabado (04, fabricado)
  const t0 = Date.now();
  const inicioVarredura = new Date(t0).toISOString();
  // Insumos da completude (ausentes.ts): itens crus por página não-vazia, códigos listados (inclusive
  // inativo='S' — inativo no Omie ainda EXISTE), itens sem código utilizável e o total declarado.
  const tamanhos: number[] = [];
  const listados = new Set<number>();
  let codigosInvalidos = 0;
  let totalDeclarado: number | undefined;

  while (pagina <= totalPaginas) {
    const result = await callOmie(account, "geral/produtos/", "ListarProdutos", {
      pagina,
      registros_por_pagina: PAGE_SIZE,
      apenas_importado_api: "N",
      filtrar_apenas_omiepdv: "N",
    }) as Record<string, unknown> & {
      total_de_paginas?: number;
      total_de_registros?: number;
      produto_servico_cadastro?: Array<Record<string, unknown>>;
    };

    // Piso monotônico + teto fail-fast (_shared/omie-paginacao.ts): o `|| 1` por resposta
    // encolhia o teto numa intermediária sem o campo e o sync completava retrato PARCIAL
    // (sync_state 'complete' + last_page mentindo).
    totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_PRODUTOS);
    const produtos = result.produto_servico_cadastro || [];
    const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
    if (veredicto === "anomalia") {
      throw new Error(`página ${pagina}/${totalPaginas} do ListarProdutos veio vazia antes do fim declarado — abortando (retrato parcial)`);
    }
    if (veredicto === "fim") break;

    tamanhos.push(produtos.length);
    const declarado = Number(result.total_de_registros);
    if (Number.isFinite(declarado) && declarado > 0) totalDeclarado = Math.max(totalDeclarado ?? 0, declarado);
    for (const p of produtos) {
      const cod = codigoValido(p.codigo_produto);
      if (cod === null) codigosInvalidos++;
      else listados.add(cod);
    }

    const rows = produtos.map((p: Record<string, unknown> & { imagens?: Array<{ url_imagem?: string }> }) => {
      const inativoFlag = p.inativo === "S";
      if (inativoFlag) totalInativos++;
      // tipo_produto = COLUNA dedicada (fora do metadata). Lê o tipoItem REAL do Omie
      // (NÃO p.tipo, que é discriminador de Kit). null → não conta como classificado e
      // o trigger anti-null-clobber preserva o valor anterior, se houver. Spec 2026-06-04.
      const tp = normalizeTipoProduto(
        (p.tipoItem ?? p.tipo_item) as string | number | null | undefined,
      );
      if (tp !== null) {
        typedCount++;
        if (tp === "04") tipo04Count++;
      }
      return {
        omie_codigo_produto: p.codigo_produto,
        omie_codigo_produto_integracao: p.codigo_produto_integracao || null,
        codigo: p.codigo || `PROD-${p.codigo_produto}`,
        descricao: p.descricao || "Sem descrição",
        unidade: p.unidade || "UN",
        ncm: p.ncm || null,
        valor_unitario: p.valor_unitario || 0,
        // Sem `estoque`: o campo do cadastro é DEPRECATED no Omie (chega 0); quem grava é o sync de estoque.
        ativo: !inativoFlag,
        account: acctValue,
        imagem_url: p.imagens?.[0]?.url_imagem || null,
        familia: p.descricao_familia || null,
        subfamilia: p.descricao_subfamilia || null,
        tipo_produto: tp,
        metadata: {
          marca: p.marca,
          modelo: p.modelo,
          peso_bruto: p.peso_bruto,
          peso_liq: p.peso_liq,
          descricao_familia: p.descricao_familia,
          cfop: p.cfop,
          inativo_omie: p.inativo,
        },
        updated_at: new Date().toISOString(),
      };
    });

    if (rows.length > 0) {
      const { error } = await db
        .from("omie_products")
        .upsert(rows, { onConflict: "omie_codigo_produto,account" });
      // Upsert com erro LANÇA: o console.error engolia a página (metadados/tipo_produto
      // perdidos) e o run ainda carimbava sync_state 'complete' com total mentindo.
      if (error) {
        throw new Error(`upsert omie_products p${pagina}: ${error.message}`);
      }
      totalUpserted += rows.length;
    }

    console.log(`[metadados ${account}] página ${pagina}/${totalPaginas} (${rows.length} itens)`);
    pagina++;
  }

  console.log(
    `[metadados ${account}] COMPLETO: ${totalUpserted} upserts, ${typedCount} classificados (tipo_produto), ${tipo04Count} produto acabado (04), ${totalPaginas} páginas`,
  );

  await db.from("sync_state").upsert(
    {
      entity_type: "products_metadados",
      account: acctValue,
      status: "complete",
      total_synced: totalUpserted,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "entity_type,account" },
  );

  // Follow-up 3 (spec 2026-06-15-tint-vigia-cobertura): corrigir a cobertura tint
  // NA FONTE. Só a conta 'oben' tem famílias "Bases/Concentrados MixMachine"; marcar
  // logo após o sync gravar os produtos fecha a janela de drift ANTES de o watchdog
  // alertar (o cron diário tint-marcar-bases-diario/jobid 132 segue como rede de
  // segurança). tint_marcar_bases_mixmachine() é idempotente/aditiva, nunca desmarca.
  // Falha aqui NÃO pode derrubar o sync (produtos já gravados) → try/catch isolado.
  // Inativação de quem sumiu do Omie. Falha aqui NÃO derruba o sync (catálogo já gravado e
  // sync_state carimbado) — surfaça no resultado e na linha dedicada (status 'erro').
  let ausentes: Awaited<ReturnType<typeof inativarAusentes>> | { status: "erro"; motivo: string };
  try {
    const completude = avaliarCompletudeCatalogo({
      tamanhos,
      porPagina: PAGE_SIZE,
      codigosInvalidos,
      unicos: listados.size,
      totalDeclarado,
    });
    ausentes = await inativarAusentes(db, acctValue, completude, listados, inicioVarredura);
  } catch (e) {
    const motivo = mensagemDeErro(e) ?? "erro sem mensagem utilizável";
    console.error(`[metadados ${account}] inativação de ausentes não rodou (sync preservado): ${motivo}`);
    ausentes = { status: "erro", motivo };
    await invalidarAusentes(db, acctValue, motivo);
  }

  let basesTintMarcadas: number | null = null;
  if (acctValue === "oben") {
    try {
      const { data: marcadas, error: tintError } = await db.rpc(
        "tint_marcar_bases_mixmachine",
      );
      if (tintError) throw tintError;
      basesTintMarcadas = typeof marcadas === "number" ? marcadas : null;
      console.log(
        `[metadados ${account}] cobertura tint: ${basesTintMarcadas ?? "?"} base(s)/concentrado(s) marcado(s)`,
      );
    } catch (tintError) {
      console.error(
        `[metadados ${account}] tint_marcar_bases_mixmachine falhou (sync preservado):`,
        tintError,
      );
    }
  }

  return {
    account: acctValue,
    paginas: totalPaginas,
    upserted: totalUpserted,
    inativos: totalInativos,
    classificados: typedCount,
    produto_acabado_04: tipo04Count,
    bases_tint_marcadas: basesTintMarcadas,
    ausentes,
    tempo_ms: Date.now() - t0,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  // ⚠️ SONDA DE VERSÃO ({"probe":true}) — ANTES do createClient, para seguir sendo o único caminho
  // sem custo. O `authorizeCron` acima aceita exatamente o `x-cron-secret` do SQL Editor ⇒ sem gate
  // próprio. O corpo teve de SUBIR para cá (req.json() não se consome duas vezes) e é reaproveitado
  // abaixo. Ver versao.ts / _shared/sonda-versao.ts.
  //
  // ⚠️ Sondar o bundle PRÉ-sensor aqui é CARO: sem `accounts` no corpo o default é as DUAS contas,
  // então `{"probe":true}` sincroniza o catálogo inteiro e ainda carimba `sync_state` — o run
  // parcial vira "fresco" e apaga o sinal de que foi parcial.
  let corpoBruto: { accounts?: OmieAccount[] } = {};
  try {
    corpoBruto = await req.json();
  } catch (_e) {
    // body opcional
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
      JSON.stringify({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Já parseado acima (para a sonda) — o `catch` que engolia corpo inválido subiu junto.
    const accounts: OmieAccount[] = corpoBruto.accounts && corpoBruto.accounts.length > 0
      ? corpoBruto.accounts
      : ["vendas", "colacor_vendas"];

    const results = [];
    for (const acct of accounts) {
      try {
        results.push(await syncMetadadosAccount(supabaseAdmin, acct));
      } catch (err) {
        console.error(`[metadados] falhou para ${acct}:`, err);
        results.push({ account: acct, error: String(err) });
        await invalidarAusentes(supabaseAdmin, getCredentials(acct).label, `conta abortou: ${mensagemDeErro(err) ?? "erro sem mensagem utilizável"}`);
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[omie-sync-metadados] erro fatal:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
