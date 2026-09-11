// Backfill de `order_items.desconto_valor` — apura o acervo relendo o Omie.
//
// ── Por que um caminho dedicado, e não "re-sincronizar" ───────────────────────────────────────
// `criar_pedidos_com_itens` tem o guard G4: pedido pai que JÁ TEM itens é contado como
// `skipped_complete` e a função não toca nos filhos. Ele existe para que reparo não vire
// reconciliação, e está certo. A consequência é que nenhum volume de re-sync preencheria o
// acervo: as 71.006 linhas existentes continuariam NULL para sempre.
//
// ── Por que reler o Omie, e não derivar do banco ──────────────────────────────────────────────
// O dado bruto não foi persistido em lugar nenhum. `sales_orders.items` (jsonb) só guarda
// `desconto`, que é a chave inexistente lida pelo código antigo — 0 em 100% das linhas. Medido
// 2026-09-08: as únicas chaves de item no jsonb são descricao, omie_codigo_produto, quantidade,
// valor_unitario, desconto e tint_nome_cor. Não há de onde derivar.
//
// ── O que esta edge NÃO decide ────────────────────────────────────────────────────────────────
// Quanto é o desconto → `_shared/desconto-omie.ts`. De quem ele é → `_shared/desconto-backfill.ts`.
// As duas têm contrato de mutação. Aqui só há transporte, paginação e contagem.
//
// ── O sensor é a entrega, não um extra ────────────────────────────────────────────────────────
// O modo de falha característico deste job é apurar pouco e parecer bem-sucedido: um erro de
// chave recusaria tudo e devolveria HTTP 200 com "0 erros". Por isso toda resposta carrega o
// DENOMINADOR (linhas alvo) junto do numerador, e as recusas vêm classificadas por motivo — que
// é o que distingue "o acervo mudou desde a ingestão" de "não sei ler o Omie".

import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";
import { atenderSondaOptions } from "../_shared/sonda-cron.ts";
import {
  conciliarDescontosPedido,
  conferirTotalPedido,
  type ConferenciaTotalPedido,
  type ItemOmieDetalhe,
  type LinhaLocal,
  type MotivoRecusa,
  pedidoNaJanela,
  registrarNaAmostra,
} from "../_shared/desconto-backfill.ts";
import { avaliarPagina, MAX_PAGINAS_PEDIDOS, proximoTotalPaginas } from "../_shared/omie-paginacao.ts";
// `fetchAll` porque o PostgREST capa em 1.000 linhas em SILÊNCIO: uma leitura truncada aqui
// tiraria irmãos do universo e a unicidade voltaria a ser medida sobre conjunto incompleto —
// o mesmo defeito por outro caminho.
import { fetchAll } from "../_shared/paginate.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
type Account = "oben" | "colacor";

/** Teto de páginas por invocação. O backfill é RETOMÁVEL (devolve `proxima_pagina`), então parar
 *  cedo é barato; estourar o tempo da edge no meio de um lote não é. */
const PAGINAS_POR_INVOCACAO_PADRAO = 12;
/** Pedidos por chamada da RPC de escrita. Lote grande amortiza round-trip, mas a trigger de
 *  coerência é DEFERRED: ela dispara no COMMIT e derruba o lote INTEIRO por causa de um pedido
 *  que já estava incoerente antes deste job existir (17 no recorte Oben/TTM, medidos 2026-09-08).
 *  Daí o retry individual mais abaixo — o lote é otimização, a corretude não depende dele. */
const PEDIDOS_POR_LOTE = 25;

function credenciais(account: Account) {
  return account === "colacor"
    ? { key: Deno.env.get("OMIE_COLACOR_APP_KEY"), secret: Deno.env.get("OMIE_COLACOR_APP_SECRET") }
    : { key: Deno.env.get("OMIE_OBEN_APP_KEY"), secret: Deno.env.get("OMIE_OBEN_APP_SECRET") };
}

async function callOmie(account: Account, endpoint: string, call: string, params: Record<string, unknown>) {
  const creds = credenciais(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais (${account}) não configuradas`);
  const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call, app_key: creds.key, app_secret: creds.secret, param: [params] }),
  });
  // HTTP não-2xx LANÇA antes de o corpo virar payload: um 429/5xx cujo corpo parseia sem
  // `faultstring` seria lido como página vazia, isto é, como FIM — e o backfill terminaria
  // "com sucesso" tendo lido metade do acervo. Mesma régua do sync.
  if (!res.ok) throw new Error(`Omie (${account}) HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.faultstring) throw new Error(`Omie (${account}): ${json.faultstring}`);
  return json;
}

/** `DD/MM/AAAA` — o formato que o ListarPedidos espera nos filtros de data. */
function dataOmie(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

interface PedidoOmie {
  cabecalho?: { codigo_pedido?: number; numero_pedido?: string | number };
  det?: ItemOmieDetalhe[];
  /** O total que o PRÓPRIO Omie calcula — testemunha por valor em `conferirTotalPedido`. */
  total_pedido?: { valor_descontos?: number | string | null };
}

/** Teto de cada amostra na resposta. A amostra é para CONFERIR à mão no Omie, não para somar. */
const AMOSTRA_MAX = 10;

Deno.serve(async (req) => {
  // A sonda responde o marcador e SAI: esta edge escreve, e uma sonda que caísse no fluxo
  // normal dispararia um backfill de verdade. `null` = não é sonda, segue o caminho normal.
  //
  // Ela mora DENTRO do bloco OPTIONS, e não antes dele, porque essa é a forma que o `gateG1` de
  // `scripts/sonda-cron-prova.ts` sabe MEDIR — e a allowlist do cron (F4 onda 5) só aceita edge
  // cujo preflight ele consegue ler.
  //
  // O que a troca preserva, e o que ela NÃO preserva (challenge Codex, 2026-09-09): a RESPOSTA de
  // todo método é idêntica, porque `atenderSondaOptions` abre com
  // `if (req.method !== METODO_SONDA) return null` (METODO_SONDA = "OPTIONS") — fora deste bloco
  // ela só devolvia `null`. O que muda é um ponto de SUSPENSÃO: para POST/GET/HEAD havia um
  // `await` antes do gate de auth, e agora não há. Isso é ordem de microtask, não resposta
  // observável — mas "provadamente neutra" era forte demais, e a diferença fica escrita aqui em vez
  // de virar surpresa de quem for medir latência ou ordem de log.
  //
  // O corpo `"ok"` fica byte a byte porque trocá-lo pelo `null` das outras edges mudaria o CORS
  // servido ao browser para agradar um gate — mudar o medido para agradar o medidor. (Não é a
  // parte (b) da prova que obriga isso: ela compara os negativos com o preflight do MESMO closure,
  // não com uma resposta anterior à mudança.)
  if (req.method === "OPTIONS") {
    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
    if (sonda) return sonda;
    return new Response("ok", { headers: corsHeaders });
  }

  // Gate na FRONTEIRA: a RPC abaixo é SECURITY DEFINER e bypassa RLS, então quem decide quem
  // pode reescrever desconto de item é aqui, não lá dentro.
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const corpo = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    // Sonda de versão ({"probe":true}) — ANTES do createClient e de qualquer chamada ao Omie,
    // para seguir sendo o único caminho SEM custo. `classificarSonda` (e não `=== true` cru) é o
    // que a torna fail-closed: um `probe` de forma inesperada vira 400 explícito em vez de cair
    // no fluxo normal e disparar um backfill de verdade — o custo que o EFEITO acima nomeia.
    const decisaoSonda = classificarSonda(corpo);
    if (decisaoSonda.tipo === "sonda") {
      return new Response(JSON.stringify(respostaSonda(VERSAO)), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (decisaoSonda.tipo === "ambiguo") {
      return new Response(
        JSON.stringify({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const account: Account = corpo.account === "colacor" ? "colacor" : "oben";
    const mesesJanela: number = Number.isFinite(corpo.meses) ? Number(corpo.meses) : 12;
    const paginaInicial: number = Number.isFinite(corpo.pagina) && Number(corpo.pagina) > 0 ? Number(corpo.pagina) : 1;
    const maxPaginas: number = Number.isFinite(corpo.max_paginas) ? Number(corpo.max_paginas) : PAGINAS_POR_INVOCACAO_PADRAO;
    // `dry_run` NÃO é um modo de teste decorativo: ele roda a conciliação inteira e devolve as
    // contagens sem escrever. É como se mede a cobertura ANTES de tocar em 10 mil linhas.
    const dryRun: boolean = corpo.dry_run === true;

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const hoje = new Date();
    const de = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - mesesJanela, hoje.getUTCDate()));
    // O MESMO limite serve ao denominador e à seleção dos candidatos — ver `pedidoNaJanela`.
    const deIso = de.toISOString().slice(0, 10);

    // ── 1. Alvo local: as linhas ainda NÃO apuradas da conta, na janela ──────────────────────
    // O denominador nasce aqui, de uma contagem no banco — não do que o Omie devolver. Contar
    // "o que consegui ler" seria o denominador se ajustando ao numerador, e nenhuma cobertura
    // calculada assim consegue ficar baixa.
    const { count: alvoTotal, error: errAlvo } = await db
      .from("order_items")
      .select("id, sales_orders!inner(account, order_date_kpi)", { count: "exact", head: true })
      .is("desconto_valor", null)
      .eq("sales_orders.account", account)
      .gte("sales_orders.order_date_kpi", deIso);
    if (errAlvo) throw new Error(`alvo: ${errAlvo.message}`);

    const contagem = {
      paginas_lidas: 0,
      pedidos_omie: 0,
      pedidos_sem_pai_local: 0,
      linhas_oferecidas: 0,
      linhas_apuradas: 0,
      ja_apuradas_puladas: 0,
      recusa_ambiguo: 0,
      recusa_sem_correspondencia: 0,
      recusa_base_indeterminada: 0,
      recusa_leitura_recusada: 0,
      escrita_pedida: 0,
      escrita_aplicada: 0,
      escrita_recusada_base_mudou: 0,
      // Conta LINHAS, não pedidos — o retry é por linha. O nome anterior mentia na unidade.
      linhas_em_pedido_incoerente: 0,
      // Os dois `continue` do laço de pedidos descartavam pedido SEM contar. Com eles, os pedidos
      // também fecham: pedidos_omie = sem_codigo + fora_da_janela + sem_pai_local
      //                               + sem_linhas_locais + conciliados.
      pedidos_sem_codigo: 0,
      pedidos_fora_da_janela: 0,
      pedidos_sem_linhas_locais: 0,
      pedidos_conciliados: 0,
    };

    // ── O SENSOR do valor (v1.3) ─────────────────────────────────────────────────────────────
    // As contagens acima dizem QUANTAS linhas foram apuradas, e nada sobre o NÚMERO apurado. Uma
    // resposta do Omie sem os campos de desconto casaria o trio em 100% das linhas e a régua
    // devolveria 0 para todas — mesma contagem, acervo inteiro carimbado "sem desconto". Daqui em
    // diante a resposta separa o 0 que o Omie INFORMOU do 0 que saiu da AUSÊNCIA dos campos.
    const diagnostico = {
      apuradas_positivas: 0,
      apuradas_zero: 0,
      zero_por_campos: { ausentes: 0, zerados: 0, informados: 0, invalidos: 0 },
      positivas_por_campos: { ausentes: 0, zerados: 0, informados: 0, invalidos: 0 },
      positivas_qtd_maior_que_1: 0,
      tipos: { V: 0, P: 0, vazio: 0, outro: 0 },
      // Controle CONHECIDO: a linha que outro writer (a ingestão) já gravou é reapurada aqui por
      // outra leitura do Omie. Divergir é sinal de que um dos dois caminhos lê errado. ⚠️ Numa
      // RETOMADA as já apuradas incluem o que o próprio backfill gravou — aí o controle é circular;
      // ele só vale como externo nas linhas que a ingestão gravou antes do backfill existir.
      ja_apuradas_conferem: 0,
      ja_apuradas_divergem: 0,
      // Conferência de cada pedido conciliado contra `total_pedido.valor_descontos` do Omie.
      pedidos_total: { confere: 0, diverge: 0, sem_total: 0, item_ilegivel: 0 } as Record<ConferenciaTotalPedido, number>,
      pedidos_com_desconto_no_total: 0,
    };
    const amostraPositivas: Array<Record<string, unknown> & { combinacao: string }> = [];
    const amostraDivergencias: Array<Record<string, unknown>> = [];
    const amostraPedidosDivergentes: Array<Record<string, unknown>> = [];
    // O PLANO por id: é o que permite conferir "os IDs escritos batem com o plano" por id e por
    // valor — contagem igual com ids trocados passaria em qualquer conferência agregada.
    const desfechos = {
      plano_escrita: [] as Array<[string, number]>,
      ja_apuradas: [] as Array<[string, number, number]>, // [id, gravado, apurado agora]
      recusadas: [] as Array<[string, MotivoRecusa]>,
    };

    let pagina = paginaInicial;
    let totalPaginas = paginaInicial;
    let pendentes: Array<{ id: string; desconto_valor: number; base_quantity: number | string | null; base_unit_price: number | string | null; base_sku: number | string | null }> = [];
    let pedidosNoLote = 0;

    /** Escreve um lote. Se a trigger DEFERRED de coerência derrubar o COMMIT por causa de um
     *  pedido que JÁ estava incoerente, refaz linha a linha para não perder o lote inteiro por
     *  causa de um vizinho — e conta os que realmente falham, em vez de engolir. */
    async function escrever(linhas: typeof pendentes) {
      if (linhas.length === 0 || dryRun) return;
      contagem.escrita_pedida += linhas.length;
      const { data, error } = await db.rpc("desconto_backfill_aplicar", { p_linhas: linhas });
      if (!error) {
        const r = data as { aplicadas?: number; recusadas?: number } | null;
        contagem.escrita_aplicada += Number(r?.aplicadas ?? 0);
        contagem.escrita_recusada_base_mudou += Number(r?.recusadas ?? 0);
        return;
      }
      // `.rpc()` NÃO lança — resolve `{error}`. Sem este ramo, um lote inteiro falharia em
      // silêncio e a edge devolveria 200 dizendo que escreveu.
      for (const linha of linhas) {
        const { data: d1, error: e1 } = await db.rpc("desconto_backfill_aplicar", { p_linhas: [linha] });
        if (e1) {
          // Só a violação CONHECIDA da trigger de coerência (23514, check_violation) vira
          // contador. Antes, QUALQUER erro caía aqui — timeout, permissão, indisponibilidade —
          // e a edge terminava HTTP 200 depois de uma falha sistêmica, com a contagem parecendo
          // apenas "alguns pedidos incoerentes". Erro que não sei nomear propaga. (Codex)
          const sqlstate = (e1 as { code?: string }).code;
          if (sqlstate !== "23514") {
            throw new Error(`escrita recusada (SQLSTATE ${sqlstate ?? "desconhecida"}): ${e1.message}`);
          }
          contagem.linhas_em_pedido_incoerente++;
          continue;
        }
        const r1 = d1 as { aplicadas?: number; recusadas?: number } | null;
        contagem.escrita_aplicada += Number(r1?.aplicadas ?? 0);
        contagem.escrita_recusada_base_mudou += Number(r1?.recusadas ?? 0);
      }
    }

    while (pagina <= totalPaginas && contagem.paginas_lidas < maxPaginas) {
      const resp = await callOmie(account, "produtos/pedido/", "ListarPedidos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        // `apenas_resumo: "N"` é o que traz `det` completo — sem ele a resposta não tem os itens
        // e o job leria páginas inteiras sem nada para conciliar.
        apenas_resumo: "N",
        filtrar_por_data_de: dataOmie(de),
        filtrar_por_data_ate: dataOmie(hoje),
      }) as { pedido_venda_produto?: PedidoOmie[]; total_de_paginas?: number };

      const pedidos = resp.pedido_venda_produto ?? [];
      // `total_de_paginas` do Omie não é confiável (CLAUDE.md): piso monotônico + teto fail-fast,
      // e página vazia ANTES do fim declarado aborta em vez de virar "acabou".
      totalPaginas = proximoTotalPaginas(totalPaginas, resp.total_de_paginas, MAX_PAGINAS_PEDIDOS);
      const veredicto = avaliarPagina(pedidos.length, pagina, totalPaginas);
      // "anomalia" = página vazia ANTES do fim declarado. Tratar isso como fim faria o backfill
      // encerrar "com sucesso" tendo lido metade do acervo — a falha silenciosa característica
      // deste job. Aborta e deixa o cursor para retomar.
      if (veredicto === "anomalia") {
        throw new Error(`página ${pagina}/${totalPaginas} do ListarPedidos veio vazia antes do fim declarado — retrato parcial, abortando (retome em pagina=${pagina})`);
      }
      contagem.paginas_lidas++;
      if (veredicto === "fim") break;

      const hashes = pedidos
        .map((p) => p.cabecalho?.codigo_pedido)
        .filter((c): c is number => typeof c === "number")
        .map((c) => `omie_${account}_${c}`);

      const { data: pais, error: errPais } = await db
        .from("sales_orders")
        .select("id, hash_payload, order_date_kpi")
        .eq("account", account)
        .in("hash_payload", hashes);
      if (errPais) throw new Error(`pais: ${errPais.message}`);

      // Só o pai DENTRO da janela oferece linhas: o filtro do Omie é por inclusão OU alteração, e
      // sem este corte um pedido antigo alterado na janela entraria no plano de escrita — fora do
      // alvo que o denominador mede e que a execução autorizou. O de fora é CONTADO, não sumido.
      const idPorHash = new Map<string, string>();
      const foraDaJanela = new Set<string>();
      for (const p of pais ?? []) {
        if (pedidoNaJanela(p.order_date_kpi, deIso)) idPorHash.set(String(p.hash_payload), String(p.id));
        else foraDaJanela.add(String(p.hash_payload));
      }

      const idsPedido = [...idPorHash.values()];
      // ⚠️ SEM `.is("desconto_valor", null)` aqui, e a ausência é o ponto. A conciliação decide
      // por UNICIDADE do trio (SKU, quantidade, preço) dos dois lados; calcular essa unicidade
      // sobre um conjunto já filtrado é medi-la em outro universo. Um pedido com duas linhas do
      // mesmo trio, uma já apurada, entregaria só a outra — que passaria a parecer ÚNICA e
      // receberia um desconto que pode ser o do irmão. Não morde na primeira passada (tudo é
      // NULL), morde em toda RETOMADA — e o job é retomável por desenho.
      //
      // Então: lê TODAS as linhas dos pedidos, concilia sobre o conjunto completo, e só depois
      // descarta as que já têm desconto. Achado da 2ª opinião (Codex), confirmado no código.
      const linhasDb = await fetchAll<{
        id: string; sales_order_id: string; omie_codigo_produto: number | string | null;
        quantity: number | string | null; unit_price: number | string | null;
        desconto_valor: number | string | null;
      }>((de, ate) =>
        db.from("order_items")
          .select("id, sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor")
          .in("sales_order_id", idsPedido)
          .order("id", { ascending: true })
          .range(de, ate)
      , "order_items do backfill de desconto");

      const porPedido = new Map<string, LinhaLocal[]>();
      // `jaApuradas`: as linhas que entram na CONCILIAÇÃO (para a unicidade ser medida no universo
      // certo) mas NÃO na escrita. Reapurar uma linha já preenchida sobrescreveria trabalho de
      // outro writer com um valor lido depois — e o UPDATE tem seu próprio guard para isso.
      const jaApuradas = new Map<string, number>(); // id → valor já gravado por outro writer
      for (const l of linhasDb) {
        const k = String(l.sales_order_id);
        const item: LinhaLocal = {
          id: String(l.id),
          omie_codigo_produto: l.omie_codigo_produto,
          quantity: l.quantity,
          unit_price: l.unit_price,
        };
        if (l.desconto_valor !== null && l.desconto_valor !== undefined) {
          jaApuradas.set(item.id, Number(l.desconto_valor));
        }
        const lista = porPedido.get(k);
        if (lista) lista.push(item);
        else porPedido.set(k, [item]);
      }

      for (const pedido of pedidos) {
        contagem.pedidos_omie++;
        const codigo = pedido.cabecalho?.codigo_pedido;
        if (typeof codigo !== "number") { contagem.pedidos_sem_codigo++; continue; }
        const hashPai = `omie_${account}_${codigo}`;
        const paiId = idPorHash.get(hashPai);
        if (!paiId) {
          if (foraDaJanela.has(hashPai)) contagem.pedidos_fora_da_janela++;
          else contagem.pedidos_sem_pai_local++;
          continue;
        }
        const locais = porPedido.get(paiId) ?? [];
        if (locais.length === 0) { contagem.pedidos_sem_linhas_locais++; continue; }
        contagem.pedidos_conciliados++;

        // Testemunha por VALOR do próprio Omie, independente do casamento com o banco.
        const total = conferirTotalPedido(pedido.det ?? [], pedido.total_pedido?.valor_descontos);
        diagnostico.pedidos_total[total.veredito]++;
        if (total.total_omie !== null && total.total_omie > 0) diagnostico.pedidos_com_desconto_no_total++;
        if (total.veredito === "diverge" && amostraPedidosDivergentes.length < AMOSTRA_MAX) {
          amostraPedidosDivergentes.push({
            numero_pedido: pedido.cabecalho?.numero_pedido ?? null,
            codigo_pedido: codigo,
            total_omie: total.total_omie,
            soma_itens: total.soma_itens,
            itens: (pedido.det ?? []).length,
          });
        }

        const plano = conciliarDescontosPedido(locais, pedido.det ?? []);
        // O denominador conta o que foi OFERECIDO à conciliação; as já apuradas entram nela (pela
        // unicidade) mas saem da escrita, e são contadas à parte para os dois números fecharem.
        contagem.linhas_oferecidas += locais.length;
        contagem.linhas_apuradas += plano.apurados.length;
        // Mapa tipado pelo próprio union em vez de uma cadeia de `else if`: com o `else` final,
        // um typo num literal ("ambiguo_") cairia no ramo de leitura recusada em silêncio e
        // inflaria o contador errado — a incompletude continuaria contada, mas mal classificada,
        // e é a CLASSIFICAÇÃO que distingue "o acervo mudou" de "não sei ler o Omie". Aqui o
        // compilador cobra uma chave por motivo, e motivo novo sem contador não compila.
        const contadorPorMotivo: Record<MotivoRecusa, () => void> = {
          ambiguo: () => contagem.recusa_ambiguo++,
          sem_correspondencia: () => contagem.recusa_sem_correspondencia++,
          base_indeterminada: () => contagem.recusa_base_indeterminada++,
          leitura_recusada: () => contagem.recusa_leitura_recusada++,
        };
        for (const r of plano.recusados) {
          contadorPorMotivo[r.motivo]();
          desfechos.recusadas.push([r.id, r.motivo]);
        }

        const porId = new Map(locais.map((l) => [l.id, l]));
        for (const a of plano.apurados) {
          const base = porId.get(a.id)!;
          // O sensor olha TODA apurada — inclusive as já gravadas —, porque ele mede a leitura do
          // Omie, não a escrita.
          const tipoChave = a.origem.tipo === "V" || a.origem.tipo === "P"
            ? a.origem.tipo
            : a.origem.tipo === "" ? "vazio" : "outro";
          diagnostico.tipos[tipoChave]++;
          if (a.desconto_valor > 0) {
            diagnostico.apuradas_positivas++;
            diagnostico.positivas_por_campos[a.origem.campos]++;
            // A base do OMIE (a que a régua usou), não a local: o casamento quantiza a 6 casas, e
            // uma linha local de qtd 1,0000001 contaria como "qtd > 1" sem ser (Codex).
            const qtdMaiorQue1 = a.origem.quantidade !== null && a.origem.quantidade > 1;
            if (qtdMaiorQue1) diagnostico.positivas_qtd_maior_que_1++;
            registrarNaAmostra(amostraPositivas, {
              combinacao: `${tipoChave}|qtd>1:${qtdMaiorQue1}`,
              id: a.id,
              numero_pedido: pedido.cabecalho?.numero_pedido ?? null,
              codigo_pedido: codigo,
              sku: base.omie_codigo_produto,
              quantidade_omie: a.origem.quantidade,
              valor_unitario_omie: a.origem.valor_unitario,
              quantidade_local: base.quantity,
              valor_unitario_local: base.unit_price,
              tipo_desconto: a.origem.tipo,
              valor_desconto: a.origem.valor_desconto,
              percentual_desconto: a.origem.percentual_desconto,
              desconto_valor: a.desconto_valor,
            }, AMOSTRA_MAX);
          } else {
            diagnostico.apuradas_zero++;
            diagnostico.zero_por_campos[a.origem.campos]++;
          }

          const gravado = jaApuradas.get(a.id);
          if (gravado !== undefined) {
            contagem.ja_apuradas_puladas++;
            desfechos.ja_apuradas.push([a.id, gravado, a.desconto_valor]);
            if (Math.abs(gravado - a.desconto_valor) < 0.005) {
              diagnostico.ja_apuradas_conferem++;
            } else {
              diagnostico.ja_apuradas_divergem++;
              if (amostraDivergencias.length < AMOSTRA_MAX) {
                amostraDivergencias.push({
                  id: a.id,
                  numero_pedido: pedido.cabecalho?.numero_pedido ?? null,
                  gravado,
                  apurado_agora: a.desconto_valor,
                  campos: a.origem.campos,
                  tipo_desconto: a.origem.tipo,
                });
              }
            }
            continue;
          }
          desfechos.plano_escrita.push([a.id, a.desconto_valor]);
          // A base viaja JUNTO do valor: a RPC reexige que a linha ainda seja a mesma na hora do
          // UPDATE. Entre esta leitura e a escrita, o sync ou uma edição podem ter mudado o preço.
          pendentes.push({
            id: a.id,
            desconto_valor: a.desconto_valor,
            base_quantity: base.quantity,
            base_unit_price: base.unit_price,
            base_sku: base.omie_codigo_produto,
          });
        }
        pedidosNoLote++;
        if (pedidosNoLote >= PEDIDOS_POR_LOTE) {
          await escrever(pendentes);
          pendentes = [];
          pedidosNoLote = 0;
        }
      }
      pagina++;
    }
    await escrever(pendentes);

    const acabou = pagina > totalPaginas;
    return new Response(
      JSON.stringify({
        versao: VERSAO,
        account,
        janela_meses: mesesJanela,
        dry_run: dryRun,
        // O denominador vem primeiro de propósito: é ele que torna o numerador legível.
        linhas_nao_apuradas_no_alvo: alvoTotal ?? null,
        ...contagem,
        diagnostico,
        amostra_positivas: amostraPositivas,
        amostra_divergencias: amostraDivergencias,
        amostra_pedidos_total_divergente: amostraPedidosDivergentes,
        desfechos,
        completo: acabou,
        proxima_pagina: acabou ? null : pagina,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    // Fail-LOUD: o backfill errado é o que devolve 200 tendo apurado pouco. Erro vira 500 com a
    // mensagem, para que o cron não registre sucesso.
    return new Response(JSON.stringify({ versao: VERSAO, error: String(e instanceof Error ? e.message : e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
