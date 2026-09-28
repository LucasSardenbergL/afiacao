// Apuração do `reprocessOrders` (sync-reprocess) — contadores, soma da resposta da RPC, decisão
// de abortar e o `metadata` do log da run. Lógica PURA, testada em ./apuracao-pedidos_test.ts.
//
// Contexto (2026-09-27, achado P2 do Codex): quando TODOS os pedidos de uma página com ≥2 pedidos
// falham na RPC `reconciliar_pedidos_omie`, a run aborta — e o catch gravava o log SEM metadata
// (`{}`). Justamente a run que aborta perdia `falhas_amostra` (e os demais contadores já apurados):
// só a 1ª falha sobrevivia no `error_message`. Aqui o metadata passa a ser montado pelo MESMO
// código nos dois desfechos, e o da run abortada carrega o que foi apurado até o abort.
//
// Ausente ≠ zero: uma run que aborta antes de apurar uma fase NÃO mediu aquela fase. Os contadores
// dela vão `null`, nunca `0` — e os denominadores (`paginas_montadas`, `paginas_reconciliadas`)
// dizem quantas páginas cada número cobre. Para o denominador ser VERDADE, cada fase só entra na
// apuração por página INTEIRA: a montagem acumula num contador da página (`MontagemPagina`) e só é
// consolidada ao fim dela; a resposta da RPC é somada de uma vez. Uma página que quebra no meio da
// montagem não deixa parcela nos números (parecer Codex no challenge desta entrega).

/** Resposta da RPC `reconciliar_pedidos_omie` para UMA página. */
export interface RespostaReconciliarPedidos {
  upserts?: number; divergences?: number; corrections?: number;
  sku_repetido?: number; ambiguo?: number; stale?: number;
  sem_item?: number; sem_pai?: number;
  identidade_adotada?: number; identidade_usada?: number;
  desconto_apurado?: number; desconto_corrigido?: number;
  falhas?: Array<Record<string, unknown>>;
}

export interface ApuracaoPedidos {
  // ── Denominadores ──
  /** Teto de páginas do ListarPedidos já lido. `null` = nenhuma resposta do Omie foi lida. */
  totalPaginasDeclarado: number | null;
  /** Página em processamento (ou a última). `null` = a run não chegou ao laço de páginas. */
  paginaEmCurso: number | null;
  /** Páginas cujo payload foi montado inteiro (fase 1: contadores da leitura do Omie). */
  paginasMontadas: number;
  /** Páginas cujo resultado de reconciliação está nos contadores (fase 2: RPC lida, ou nada a
   *  reconciliar na página). A página que aborta por "todos falharam" CONTA: a resposta dela foi
   *  lida e somada antes do abort. A que aborta por erro da RPC não conta: não houve resposta. */
  paginasReconciliadas: number;

  // ── Fase 1: montagem do payload ──
  itensLidos: number;
  itensComIdentidade: number;
  descontoIlegivel: number;
  descontoIlegivelAmostra: Array<number | string>;
  itemSemCodigo: number;
  itemSemCodigoAmostra: Array<number | string>;

  // ── Fase 2: resposta da RPC ──
  upserts: number;
  divergences: number;
  corrections: number;
  falhas: number;
  skuRepetido: number;
  ambiguos: number;
  stale: number;
  identidadeAdotada: number;
  identidadeUsada: number;
  falhasAmostra: Array<Record<string, unknown>>;
  // SENSORES do desconto da linha (migration 20260914180104). `null` = alguma página voltou SEM a
  // chave, isto é, a RPC no ar é a anterior.
  descontoApurado: number | null;
  descontoCorrigido: number | null;
}

const TETO_AMOSTRA = 20;

export function novaApuracaoPedidos(): ApuracaoPedidos {
  return {
    totalPaginasDeclarado: null,
    paginaEmCurso: null,
    paginasMontadas: 0,
    paginasReconciliadas: 0,
    itensLidos: 0,
    itensComIdentidade: 0,
    descontoIlegivel: 0,
    descontoIlegivelAmostra: [],
    itemSemCodigo: 0,
    itemSemCodigoAmostra: [],
    upserts: 0,
    divergences: 0,
    corrections: 0,
    falhas: 0,
    skuRepetido: 0,
    ambiguos: 0,
    stale: 0,
    identidadeAdotada: 0,
    identidadeUsada: 0,
    falhasAmostra: [],
    descontoApurado: 0,
    descontoCorrigido: 0,
  };
}

/** Contadores da fase 1 de UMA página, consolidados na apuração só quando a montagem termina. */
export interface MontagemPagina {
  itensLidos: number;
  itensComIdentidade: number;
  descontoIlegivel: number;
  descontoIlegivelAmostra: Array<number | string>;
  itemSemCodigo: number;
  itemSemCodigoAmostra: Array<number | string>;
}

export function novaMontagemPagina(): MontagemPagina {
  return {
    itensLidos: 0,
    itensComIdentidade: 0,
    descontoIlegivel: 0,
    descontoIlegivelAmostra: [],
    itemSemCodigo: 0,
    itemSemCodigoAmostra: [],
  };
}

export function registrarDescontoIlegivel(pg: MontagemPagina, codigoPedido: number | string): void {
  pg.descontoIlegivel++;
  pg.descontoIlegivelAmostra.push(codigoPedido);
}

export function registrarItemSemCodigo(pg: MontagemPagina, codigoPedido: number | string): void {
  pg.itemSemCodigo++;
  pg.itemSemCodigoAmostra.push(codigoPedido);
}

/** Fecha a montagem da página: soma na apuração e conta a página no denominador da fase 1. */
export function consolidarMontagem(ap: ApuracaoPedidos, pg: MontagemPagina): void {
  ap.itensLidos += pg.itensLidos;
  ap.itensComIdentidade += pg.itensComIdentidade;
  ap.descontoIlegivel += pg.descontoIlegivel;
  ap.itemSemCodigo += pg.itemSemCodigo;
  for (const c of pg.descontoIlegivelAmostra) {
    if (ap.descontoIlegivelAmostra.length >= TETO_AMOSTRA) break;
    ap.descontoIlegivelAmostra.push(c);
  }
  for (const c of pg.itemSemCodigoAmostra) {
    if (ap.itemSemCodigoAmostra.length >= TETO_AMOSTRA) break;
    ap.itemSemCodigoAmostra.push(c);
  }
  ap.paginasMontadas++;
}

/**
 * Soma a resposta da RPC de UMA página e devolve as falhas dela. A amostra é gravada AQUI, antes
 * de qualquer decisão de abortar — é o que faz a página que aborta chegar ao `metadata`.
 */
export function somarRespostaRpc(
  ap: ApuracaoPedidos,
  r: RespostaReconciliarPedidos,
): Array<Record<string, unknown>> {
  ap.upserts += r.upserts || 0;
  ap.divergences += r.divergences || 0;
  ap.corrections += r.corrections || 0;
  ap.skuRepetido += r.sku_repetido || 0;
  const fails = r.falhas || [];
  ap.falhas += fails.length;
  for (const f of fails) {
    if (ap.falhasAmostra.length >= TETO_AMOSTRA) break;
    // Só metadado, com a mensagem cortada — é o que sobrevive à retenção dos logs da edge.
    ap.falhasAmostra.push({
      omie_pedido_id: f.omie_pedido_id ?? null,
      sqlstate: f.sqlstate ?? null,
      erro: typeof f.erro === "string" ? f.erro.slice(0, 160) : null,
    });
  }
  // Sensor AUSENTE não é zero: uma página sem a chave (RPC anterior à 20260914180104) torna o
  // total null para o resto da run — somar `|| 0` afirmaria "nada apurado" sobre o que não se mediu.
  ap.descontoApurado = ap.descontoApurado !== null && typeof r.desconto_apurado === "number"
    ? ap.descontoApurado + r.desconto_apurado
    : null;
  ap.descontoCorrigido = ap.descontoCorrigido !== null && typeof r.desconto_corrigido === "number"
    ? ap.descontoCorrigido + r.desconto_corrigido
    : null;
  ap.ambiguos += r.ambiguo || 0;
  ap.stale += r.stale || 0;
  ap.identidadeAdotada += r.identidade_adotada || 0;
  ap.identidadeUsada += r.identidade_usada || 0;
  ap.paginasReconciliadas++;
  return fails;
}

/**
 * [P1-4] A página INTEIRA falhou na RPC ⇒ falha sistêmica, a run aborta. Com UM pedido só na
 * página, "todos falharam" não separa falha sistêmica de um pedido ruim — e um pedido ruim sozinho
 * na última página derrubaria toda run que o alcançasse (parecer Codex, 2026-09-14).
 */
export function paginaInteiraFalhou(nFalhas: number, nPedidos: number): boolean {
  return nFalhas > 0 && nFalhas === nPedidos && nPedidos > 1;
}

/** Chamada à RPC `reconciliar_pedidos_omie` de uma página (injetada: o teste a simula). */
export type ChamarRpcReconciliar = () => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Reconcilia UMA página: chama a RPC, LANÇA no erro dela, soma a resposta e decide abortar — nesta
 * ordem, que é o que o teste executa. Página sem pedido elegível não chama a RPC e conta como
 * reconciliada (o resultado dela, nenhuma escrita, já está nos contadores).
 */
export async function reconciliarPagina(
  ap: ApuracaoPedidos,
  nPedidos: number,
  chamarRpc: ChamarRpcReconciliar,
  account: string,
  pagina: number,
): Promise<void> {
  if (nPedidos === 0) {
    ap.paginasReconciliadas++;
    return;
  }
  const { data, error } = await chamarRpc();
  if (error) {
    // Money-path: a RPC é o ÚNICO caminho de escrita agora. Se ela falha (migration não
    // aplicada, grant, lista de status divergente da canônica), LANÇAR — senão a run fica
    // verde sem reconciliar nada e o log marca 'complete' mascarando perda total. Mesma
    // decisão que o `criar_pedidos_com_itens` do omie-vendas-sync tomou (achado /codex).
    // A página NÃO entra em `paginasReconciliadas`: não houve resposta para somar.
    throw new Error(`[Reprocess][${account}] RPC reconciliar_pedidos_omie falhou pág ${pagina}: ${error.message}`);
  }
  const r = (data ?? {}) as RespostaReconciliarPedidos;
  // A soma (e a amostra das falhas) acontece ANTES da decisão de abortar: é o que leva a página
  // que aborta ao `metadata` gravado pelo catch.
  const fails = somarRespostaRpc(ap, r);
  if (fails.length > 0) {
    console.error(`[Reprocess][${account}] ${fails.length} pedido(s) FALHARAM na RPC pág ${pagina}:`, JSON.stringify(fails.slice(0, 5)));
  }
  if (r.ambiguo) {
    console.warn(`[Reprocess][${account}] ${r.ambiguo} pedido(s) NÃO reconciliados por ambiguidade sem identidade de linha (${r.sku_repetido || 0} por SKU repetido no payload do Omie; o resto por duplicidade já gravada no banco) — seguem na revisão anterior COMPLETA`);
  }
  if (r.stale) {
    console.warn(`[Reprocess][${account}] ${r.stale} pedido(s) pulados por leitura mais VELHA que a já publicada (compare-and-set)`);
  }
  // [P1-4] Se a página INTEIRA falhou, isto não é "alguns pedidos ruins" — é sinal de que
  // algo sistêmico passou pela allowlist da RPC. Lançar, em vez de somar e seguir para a
  // página seguinte acumulando o mesmo erro 100 vezes. Com UM pedido só na página, não
  // aborta (ver `paginaInteiraFalhou`); ele segue em `falhas`.
  if (paginaInteiraFalhou(fails.length, nPedidos)) {
    throw new Error(`[Reprocess][${account}] TODOS os ${fails.length} pedidos da pág ${pagina} falharam na RPC — falha sistêmica, não dado sujo: ${JSON.stringify(fails[0])}`);
  }
  console.log(`[Reprocess][${account}] RPC pág ${pagina}: upserts=${r.upserts || 0} corrections=${r.corrections || 0} divergences=${r.divergences || 0} sem_pai=${r.sem_pai || 0} sem_item=${r.sem_item || 0} identidade_adotada=${r.identidade_adotada || 0} identidade_usada=${r.identidade_usada || 0}`);
}

export type DesfechoRun = { tipo: "completa" } | { tipo: "abortada" };

/** Contadores das colunas do log. Na run abortada sem nenhuma página reconciliada: `null`. */
export function contagensDoLog(
  ap: ApuracaoPedidos,
  desfecho: DesfechoRun,
): { upserts_count: number | null; divergences_found: number | null; corrections_applied: number | null } {
  const apurado = desfecho.tipo === "completa" || ap.paginasReconciliadas > 0;
  return {
    upserts_count: apurado ? ap.upserts : null,
    divergences_found: apurado ? ap.divergences : null,
    corrections_applied: apurado ? ap.corrections : null,
  };
}

/**
 * `metadata` do `sync_reprocess_log` da run. O da run COMPLETA é o de sempre, chave por chave. O da
 * run ABORTADA leva o que foi apurado até o abort, cada fase gateada pelo seu denominador: fase não
 * apurada vai `null`, nunca `0` nem `[]`.
 */
export function metadataPedidos(
  ap: ApuracaoPedidos,
  windowDays: number,
  desfecho: DesfechoRun,
): Record<string, unknown> {
  const completa = desfecho.tipo === "completa";
  const montou = completa || ap.paginasMontadas > 0;
  const reconciliou = completa || ap.paginasReconciliadas > 0;
  const f1 = <T>(v: T): T | null => (montou ? v : null);
  const f2 = <T>(v: T): T | null => (reconciliou ? v : null);

  const metadata: Record<string, unknown> = {
    pages: ap.totalPaginasDeclarado,
    window_days: windowDays,
    falhas: f2(ap.falhas),
    sku_repetido: f2(ap.skuRepetido),
    ambiguos: f2(ap.ambiguos),
    stale: f2(ap.stale),
    // SENSOR da identidade de linha, com DENOMINADOR (`itens_lidos`). É por esta chave que se
    // responde, contra a PROD e sem depender da doc do Omie, se o `ListarPedidos` devolve
    // `det.ide.codigo_item`:
    //   itens_com_codigo_item = 0 e itens_lidos > 0  → o campo NÃO vem; tudo segue no SKU
    //   itens_com_codigo_item > 0                    → vem, e a adoção já está acontecendo
    //   itens_lidos = 0                              → não houve item na janela: SEM DADO,
    //                                                  e é isso que o denominador impede de
    //                                                  ler como "o campo não vem"
    itens_lidos: f1(ap.itensLidos),
    itens_com_codigo_item: f1(ap.itensComIdentidade),
    identidade_adotada: f2(ap.identidadeAdotada),
    identidade_usada: f2(ap.identidadeUsada),
    // Pedidos NÃO reconciliados por desconto ilegível — o registro que sobrevive à janela.
    desconto_ilegivel: f1(ap.descontoIlegivel),
    desconto_ilegivel_amostra: f1(ap.descontoIlegivelAmostra),
    // Pedidos NÃO reconciliados por item sem código de produto utilizável — idem, sobrevive à janela.
    item_sem_codigo: f1(ap.itemSemCodigo),
    item_sem_codigo_amostra: f1(ap.itemSemCodigoAmostra),
    // Falhas por pedido que a RPC isolou (revertidas inteiras) — antes, só no console.
    falhas_amostra: f2(ap.falhasAmostra),
    // SENSORES do desconto da linha (RPC 20260914180104). `null` = a RPC no ar é a anterior (ou,
    // na run abortada, nenhuma página chegou a ser reconciliada).
    desconto_apurado: f2(ap.descontoApurado),
    desconto_corrigido: f2(ap.descontoCorrigido),
  };
  if (completa) return metadata;
  return {
    ...metadata,
    abortada: true,
    pagina_abortada: ap.paginaEmCurso,
    paginas_montadas: ap.paginasMontadas,
    paginas_reconciliadas: ap.paginasReconciliadas,
  };
}
