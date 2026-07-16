// Classificação PURA de uma página do PesquisarPedCompra (reconciliação de PO excluído no Omie — PR1).
// Espelhada no edge omie-sync-pedidos-compra entre // MIRROR-START/END (Deno não importa de src/); a paridade
// NORMALIZADA no CI (edge-money-path-invariants) pega a reversão do deploy do Lovable. Ver docs/agent/money-path.md.
//
// POR QUE UM PARSER PURO (e não mais um `if` no loop): seis Codex challenge xhigh seguidos (v3.3→v3.8) acharam
// furos NESTA lógica, um shape por vez — {raw}→[]→fim; faultcode sem faultstring; alias em tipo conflitante;
// 2 listas array (uma vazia, outra cheia); vazio contradizendo os totais; fault escapando do guard; piso não
// acumulando entre páginas; piso comparando linhas em vez de IDs distintos; sobreposição parcial de página;
// nPagina stale. Remendo shape-a-shape não converge, e guardrail textual (grep de nome) não prova comportamento.
// Aqui a matriz inteira vira teste de vitest (omie-pagina.test.ts).
//
// INVARIANTE-MOR: os totais do Omie (nTotalRegistros/nTotalPaginas) são PISO de sanidade, NUNCA teto — o Omie
// SUB-REPORTA (armadilha #979/#1009), por isso paginamos até a página vazia e JAMAIS paramos por causa do total.
// Corolário: se o real > declarado, os predicados do piso dão false e a coleta segue (nada de falso truncamento).

// MIRROR-START reposicao omie-pagina
export interface OmiePaginaResp {
  faultstring?: unknown;
  faultcode?: unknown;
  nPagina?: unknown;
  nTotalPaginas?: unknown;
  nTotalRegistros?: unknown;
  pedidos_pesquisa?: unknown;
  pedido_compra_produto?: unknown;
  pedidoCompraProduto?: unknown;
}

/** Maior total já declarado pelo Omie em QUALQUER resposta deste run (fault inclusive). Só cresce. */
export interface PisoTotais {
  registros: number;
  paginas: number;
}

export type ClassificacaoPagina =
  | { tipo: "dados"; ids: number[]; pedidos: unknown[] }
  | { tipo: "fim" }
  | { tipo: "anomalia"; motivo: string };

export interface CtxPagina {
  /** página SOLICITADA nesta chamada */
  pagina: number;
  /** IDs canônicos distintos já coletados nas páginas ANTERIORES */
  idsVistos: ReadonlySet<number>;
  /** piso acumulado até aqui (já incluindo esta resposta — ver acumularPiso) */
  piso: PisoTotais;
}

export const PISO_ZERO: PisoTotais = { registros: 0, paginas: 0 };

const FIM_SEM_REGISTROS_RE = /n[ãa]o existem registros/i;

/**
 * PISO ACUMULADO: o maior total declarado até agora. Nunca decresce — uma resposta terminal SEM totais não pode
 * apagar o que uma página anterior declarou (senão um run que perde as últimas páginas parece completo).
 */
export function acumularPiso(resp: OmiePaginaResp, piso: PisoTotais): PisoTotais {
  const reg = Number(resp?.nTotalRegistros);
  const pag = Number(resp?.nTotalPaginas);
  return {
    registros: Number.isFinite(reg) && reg > piso.registros ? reg : piso.registros,
    paginas: Number.isFinite(pag) && pag > piso.paginas ? pag : piso.paginas,
  };
}

/**
 * nCodPed CANÔNICO: presente, inteiro SEGURO (>2^53 o Number arredondaria → carimbaria um bigint ERRADO no
 * sinal) e positivo. Qualquer coisa fora disso é null → o chamador invalida a coleta (o PO não é rastreável).
 */
export function lerNCodPed(pedido: unknown): number | null {
  const p = pedido as
    | { cabecalho_consulta?: { nCodPed?: unknown }; cabecalho?: { nCodPed?: unknown } }
    | null
    | undefined;
  const raw = p?.cabecalho_consulta?.nCodPed ?? p?.cabecalho?.nCodPed;
  // NÃO usar Number(raw) direto: ele COAGE true→1, "1e3"→1000, [5]→5, " 7 "→7 — um ID ERRADO entraria no sinal
  // sem invalidar nada. Canônico = number inteiro seguro >0, ou string de DÍGITOS (o contrato do Omie declara
  // nCodPed integer). Qualquer outra representação = ilegível → null → o chamador invalida a coleta.
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * O FIM (lista vazia OU fault "sem registros") só é legítimo se COERENTE com o piso: se o Omie declarou mais
 * registros do que os IDs distintos coletados, ou declarou que ESTA página existe, então é TRUNCAMENTO — não
 * "empresa vazia". Publicar um vazio contraditório daria ids=0 → volume_ok=true → marcador VAZIO falso-válido,
 * e TODO PO viraria candidato de uma vez. Piso zerado/ausente => empresa vazia legítima, segue válida.
 */
function fimCoerente(ctx: CtxPagina): boolean {
  const faltamRegistros = ctx.piso.registros > ctx.idsVistos.size;
  const paginaDeveriaExistir = ctx.piso.paginas >= ctx.pagina;
  return !faltamRegistros && !paginaDeveriaExistir;
}

function incoerencia(ctx: CtxPagina, o_que: string): string {
  return `${o_que} contradiz o piso do Omie (registros=${ctx.piso.registros} ids_distintos=${ctx.idsVistos.size} paginas=${ctx.piso.paginas} pagina=${ctx.pagina})`;
}

/**
 * Classifica UMA página: `dados` (seguir), `fim` (encerrar limpo) ou `anomalia` (abortar e INVALIDAR a
 * publicação). Fail-closed: na dúvida, anomalia — publicar sinal de run inválido envenena a base de verdade que
 * o PR2 usa para decidir o que provar por ID.
 */
export function classificarPagina(resp: OmiePaginaResp, ctx: CtxPagina): ClassificacaoPagina {
  if (!resp || typeof resp !== "object") return { tipo: "anomalia", motivo: "resposta não é um objeto" };

  // (a) a página DECLARADA tem de ser a SOLICITADA — resposta stale/misrouted ({nPagina:3} quando pedimos a 2)
  //     publicaria um fim falso. Ausente é tolerado (nem toda resposta traz nPagina); divergente é anomalia.
  const npRaw = resp.nPagina;
  if (npRaw !== undefined && npRaw !== null && npRaw !== "") {
    const np = Number(npRaw);
    if (!Number.isSafeInteger(np) || np !== ctx.pagina) {
      return { tipo: "anomalia", motivo: `nPagina declarada (${String(npRaw)}) != solicitada (${ctx.pagina})` };
    }
  }

  const aliases = [resp.pedidos_pesquisa, resp.pedido_compra_produto, resp.pedidoCompraProduto];
  const listas = aliases.filter((a): a is unknown[] => Array.isArray(a));
  const algumConflitante = aliases.some((a) => a !== undefined && a !== null && !Array.isArray(a));

  // (b) fault: erro de APLICAÇÃO do Omie — pode vir com HTTP 200 carregando faultcode E/OU faultstring.
  const temFault = (resp.faultstring !== undefined && resp.faultstring !== null && resp.faultstring !== "") ||
    (resp.faultcode !== undefined && resp.faultcode !== null && resp.faultcode !== "");
  if (temFault) {
    const fs = String(resp.faultstring ?? "");
    if (fs && FIM_SEM_REGISTROS_RE.test(fs)) {
      // fault TERMINAL ("não existem registros"). Se a PRÓPRIA resposta traz pedidos ou shape torto, ela se
      // CONTRADIZ → anomalia (senão publicaríamos ids=[] com um PO visível na mão).
      if (algumConflitante || listas.length > 1) {
        return { tipo: "anomalia", motivo: 'fault "sem registros" com aliases tortos' };
      }
      if (listas.length === 1 && listas[0].length > 0) {
        return { tipo: "anomalia", motivo: `fault "sem registros" mas a resposta traz ${listas[0].length} pedido(s)` };
      }
      return fimCoerente(ctx) ? { tipo: "fim" } : { tipo: "anomalia", motivo: incoerencia(ctx, 'fault "sem registros"') };
    }
    return { tipo: "anomalia", motivo: `fault: ${fs || String(resp.faultcode)}` };
  }

  // (c) 2xx sem fault: precisa ser EXATAMENTE 1 lista conhecida (o contrato do Omie declara só pedidos_pesquisa;
  //     2 listas divergentes ou alias em tipo conflitante já viraram fim espúrio antes).
  if (listas.length !== 1 || algumConflitante) {
    return {
      tipo: "anomalia",
      motivo: `shape anômalo (listas=${listas.length}, alias conflitante=${algumConflitante})`,
    };
  }
  const pedidos = listas[0];

  // (d) lista vazia → mesmo classificador terminal do fault.
  if (pedidos.length === 0) {
    return fimCoerente(ctx) ? { tipo: "fim" } : { tipo: "anomalia", motivo: incoerencia(ctx, "lista vazia") };
  }

  // (e) dados: todo registro precisa de nCodPed CANÔNICO, e nenhum pode REPETIR um ID (de página anterior ou da
  //     própria página). Sobreposição = a paginação girou/duplicou: o Set deduplicaria em silêncio e o piso
  //     bateria com menos POs do que o universo real → um PO sumiria do sinal sem ninguém notar.
  const ids: number[] = [];
  const idsDaPagina = new Set<number>();
  for (const p of pedidos) {
    const id = lerNCodPed(p);
    if (id === null) return { tipo: "anomalia", motivo: "pedido sem nCodPed canônico (ausente/ilegível/inseguro)" };
    if (ctx.idsVistos.has(id)) {
      return { tipo: "anomalia", motivo: `nCodPed ${id} repetido de página anterior (sobreposição de paginação)` };
    }
    if (idsDaPagina.has(id)) return { tipo: "anomalia", motivo: `nCodPed ${id} duplicado na mesma página` };
    idsDaPagina.add(id);
    ids.push(id);
  }
  return { tipo: "dados", ids, pedidos };
}
// MIRROR-END reposicao omie-pagina
