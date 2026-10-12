// Coleta da fila do picking v2 (Fase 0.5): listagem da etapa 10 → lote de `picking_sincronizar_fila`.
// PURO (a chamada ao Omie é injetada) — testado em coleta_test.ts (Deno, `--no-remote`).
// Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §1.3, §2.1, §3.6.
//
// Contratos que este módulo carrega (o banco é a autoridade de validação dos itens; aqui só não se
// FABRICA nada):
//   - Paginação até a página vazia (o "Não existem registros" do Omie também é página vazia), com
//     teto de páginas. `total_de_paginas` não é confiável e não é usado.
//   - Listagem não é fotografia: `total_de_registros` divergente entre páginas, código repetido entre
//     páginas ou registro sem `codigo_pedido` = listagem INCOMPLETA. Os presentes vão ao banco com a
//     repetição (o banco recusa a completude sozinho, não depende desta flag).
//   - Qualquer página com erro aborta a coleta inteira — nada parcial chega ao banco.
//   - O corte de data decide só a ADMISSÃO (`dInc` nos últimos N dias); `dInc` ausente/ilegível =
//     não admitido (ausente ≠ recente). Tarefa já acompanhada entra sempre que presente.

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

const CODIGO = /^[1-9][0-9]{0,17}$/;

/** Código do Omie como texto canônico (o banco lê bigint); inválido = null. */
export function codigoOmie(v: unknown): string | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  const t = texto(v);
  // Também o texto fica no inteiro seguro do JS: o lote vai ao banco como número (JSON).
  return t !== null && CODIGO.test(t) && BigInt(t) <= BigInt(Number.MAX_SAFE_INTEGER) ? t : null;
}

/**
 * Quantidade como texto decimal SEM notação científica. Número que o JS só sabe escrever em
 * notação científica, ou texto que não é decimal simples, passa adiante como veio: o banco o
 * recusa e a tarefa nasce `bloqueado_dado` — melhor que arredondar uma quantidade.
 */
export function quantidadeTexto(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return texto(v);
}

interface ItemNormalizado {
  codigo_item: string | null;
  codigo_produto: string | null;
  codigo: string | null;
  descricao: string | null;
  quantidade: string | null;
  unidade: string | null;
  ean: string | null;
}

export interface PedidoNormalizado {
  codigo_pedido: string;
  numero_pedido: string | null;
  cliente_nome: string | null;
  d_alt: string | null;
  h_alt: string | null;
  /** `infoCadastro.dInc` em ISO — a sync grava em `picking_tarefas.incluido_em` (janela da listagem). */
  incluido_em: string | null;
  itens: ItemNormalizado[];
}

/**
 * Um registro de `ListarPedidos`/`ConsultarPedido` → formato que `picking_sincronizar_fila` espera.
 * `null` = sem `codigo_pedido` válido (não dá para nem identificar o pedido). Item malformado passa
 * com o campo `null`: quem decide `bloqueado_dado` é o banco (`picking_v2_motivo_invalido`).
 * `cliente_nome` não vem na listagem (só `codigo_cliente`) — fica null.
 */
export function normalizarPedido(registro: unknown): PedidoNormalizado | null {
  const ped = obj(registro);
  const cab = obj(ped?.cabecalho);
  const codigo = codigoOmie(cab?.codigo_pedido);
  if (codigo === null) return null;
  const info = obj(ped?.infoCadastro);
  const itens: ItemNormalizado[] = lista(ped?.det).map((d) => {
    const linha = obj(d);
    const prod = obj(linha?.produto);
    return {
      codigo_item: codigoOmie(obj(linha?.ide)?.codigo_item),
      codigo_produto: codigoOmie(prod?.codigo_produto),
      codigo: texto(prod?.codigo),
      descricao: texto(prod?.descricao),
      quantidade: quantidadeTexto(prod?.quantidade),
      unidade: texto(prod?.unidade),
      ean: texto(prod?.ean),
    };
  });
  return {
    codigo_pedido: codigo,
    numero_pedido: texto(cab?.numero_pedido),
    cliente_nome: null,
    d_alt: texto(info?.dAlt),
    h_alt: texto(info?.hAlt),
    incluido_em: dataOmieParaIso(info?.dInc),
    itens,
  };
}

const DATA_OMIE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** `dd/mm/aaaa` do Omie → `aaaa-mm-dd`; ilegível = null. */
export function dataOmieParaIso(v: unknown): string | null {
  const t = texto(v);
  const m = t === null ? null : DATA_OMIE.exec(t);
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  const d = new Date(Date.UTC(Number(aaaa), Number(mm) - 1, Number(dd)));
  if (d.getUTCFullYear() !== Number(aaaa) || d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) {
    return null;
  }
  return `${aaaa}-${mm}-${dd}`;
}

/** Data de inclusão do registro (`infoCadastro.dInc`) em ISO; ausente/ilegível = null. */
function dataInclusao(registro: unknown): string | null {
  return dataOmieParaIso(obj(obj(registro)?.infoCadastro)?.dInc);
}

// ─── Paginação ────────────────────────────────────────────────────────────────────────────────

/** Uma página do Omie: o corpo, "não há mais registros", ou erro (aborta a coleta). */
export type Pagina =
  | { tipo: "corpo"; corpo: unknown }
  | { tipo: "fim" }
  | { tipo: "erro"; erro: string };

/** Fault do Omie que significa "página além do fim" — é página vazia, não erro. */
export function faultDeFimDePagina(fault: string): boolean {
  return /n[ãa]o existem registros/i.test(fault);
}

export interface Listagem {
  registros: unknown[];
  /** Códigos na ordem em que vieram, COM repetição entre páginas (o banco decide a completude). */
  presentes: string[];
  /** Último `total_de_registros` lido; null se nenhuma página o trouxe legível. */
  total_de_registros: number | null;
  paginas: number;
  completa: boolean;
  motivos_incompleta: string[];
}

export type ResultadoListagem = { ok: true; listagem: Listagem } | { ok: false; erro: string; paginas: number };

/**
 * Pagina até a página vazia (ou o "não existem registros"), com teto. `listar(pagina)` faz UMA
 * chamada. Erro em qualquer página aborta tudo (nada parcial). Teto estourado também é erro: uma
 * listagem que não terminou não é listagem.
 */
export async function paginar(
  listar: (pagina: number) => Promise<Pagina>,
  opts: { tetoPaginas: number; entrePaginas?: () => Promise<void> },
): Promise<ResultadoListagem> {
  const registros: unknown[] = [];
  const presentes: string[] = [];
  const totais = new Set<number>();
  const motivos = new Set<string>();
  let semTotal = false;
  let paginas = 0;
  for (let pagina = 1; ; pagina++) {
    if (pagina > opts.tetoPaginas) {
      return { ok: false, erro: `teto de ${opts.tetoPaginas} páginas atingido sem página vazia`, paginas };
    }
    if (pagina > 1 && opts.entrePaginas) await opts.entrePaginas();
    const p = await listar(pagina);
    paginas++;
    if (p.tipo === "erro") return { ok: false, erro: `página ${pagina}: ${p.erro}`, paginas };
    if (p.tipo === "fim") {
      // "Não existem registros" já na 1ª página = etapa vazia no filtro: total 0 VALIDADO (sem
      // isso, um filtro vazio legítimo abortaria toda rodada — Codex 0.5b P1-3).
      if (pagina === 1) totais.add(0);
      break;
    }
    const corpo = obj(p.corpo);
    const doLote = lista(corpo?.pedido_venda_produto);
    const total = corpo?.total_de_registros;
    const totalLegivel = typeof total === "number" && Number.isInteger(total) && total >= 0;
    // Só a página com registros — ou a 1ª, vazia — informa o total: o vazio da 1ª com total 0 é
    // legítimo; o da página além do fim é só o sinal de parada.
    if (doLote.length > 0 || pagina === 1) {
      if (totalLegivel) totais.add(total);
      else semTotal = true;
    }
    if (doLote.length === 0) break;
    for (const r of doLote) {
      registros.push(r);
      const cod = codigoOmie(obj(obj(r)?.cabecalho)?.codigo_pedido);
      if (cod === null) motivos.add("registro_sem_codigo_pedido");
      else presentes.push(cod);
    }
  }
  if (semTotal) motivos.add("pagina_sem_total_de_registros");
  if (totais.size > 1) motivos.add("total_de_registros_mudou_entre_paginas");
  if (new Set(presentes).size !== presentes.length) motivos.add("codigo_repetido_entre_paginas");
  const total = totais.size === 0 ? null : [...totais].at(-1) ?? null;
  if (total !== null && presentes.length !== total) motivos.add("presentes_diferente_do_total");
  if (total === null) motivos.add("sem_total_de_registros");
  return {
    ok: true,
    listagem: {
      registros,
      presentes,
      total_de_registros: total,
      paginas,
      completa: motivos.size === 0,
      motivos_incompleta: [...motivos].sort(),
    },
  };
}

// ─── Lote para o banco ────────────────────────────────────────────────────────────────────────

export interface Lote {
  /** Para `p_pedidos`: admitidos pelo corte ∪ acompanhados presentes, sem repetição. */
  pedidos: PedidoNormalizado[];
  admitidos_pelo_corte: number;
  acompanhados_presentes: number;
  fora_do_corte: number;
  sem_data_inclusao: number;
}

/**
 * Escolhe o que vai detalhado ao banco. `corteIso` = 1º dia admitido (`aaaa-mm-dd`, inclusive).
 * Registro repetido entre páginas: fica o ÚLTIMO (o mais recente lido) — `p_pedidos` não pode ter
 * repetição (22023), e a repetição já marcou a listagem incompleta.
 */
export function montarLote(registros: unknown[], corteIso: string, acompanhados: ReadonlySet<string>): Lote {
  const porCodigo = new Map<string, { ped: PedidoNormalizado; dInc: string | null }>();
  for (const r of registros) {
    const ped = normalizarPedido(r);
    if (ped) porCodigo.set(ped.codigo_pedido, { ped, dInc: dataInclusao(r) });
  }
  const lote: Lote = { pedidos: [], admitidos_pelo_corte: 0, acompanhados_presentes: 0, fora_do_corte: 0, sem_data_inclusao: 0 };
  for (const [cod, { ped, dInc }] of porCodigo) {
    const acompanhado = acompanhados.has(cod);
    const noCorte = dInc !== null && dInc >= corteIso;
    if (dInc === null) lote.sem_data_inclusao++;
    if (acompanhado) lote.acompanhados_presentes++;
    if (noCorte) lote.admitidos_pelo_corte++;
    if (acompanhado || noCorte) lote.pedidos.push(ped);
    else lote.fora_do_corte++;
  }
  lote.pedidos.sort((a, b) => (BigInt(a.codigo_pedido) < BigInt(b.codigo_pedido) ? -1 : 1));
  return lote;
}

// ─── Resumo do modo leitura ──────────────────────────────────────────────────────────────────

export interface ResumoLeitura {
  paginas: number;
  total_de_registros: number | null;
  presentes: number;
  completa: boolean;
  motivos_incompleta: string[];
  admitidos_pelo_corte: number;
  fora_do_corte: number;
  sem_data_inclusao: number;
  /** Quantos registros devolvidos pelo FILTRO têm `dInc` antes do corte — mede o que o filtro corta. */
  dinc_antes_do_corte: number;
  dinc_mais_antigo: string | null;
  linhas: number;
  linhas_sem_codigo_item: number;
  linhas_sem_codigo_produto: number;
  linhas_sem_quantidade: number;
  linhas_sem_unidade: number;
  linhas_com_ean: number;
  pedidos_sem_itens: number;
  bytes_do_lote: number;
}

export function resumirLeitura(listagem: Listagem, corteIso: string): ResumoLeitura {
  const lote = montarLote(listagem.registros, corteIso, new Set());
  let antes = 0;
  let maisAntigo: string | null = null;
  for (const r of listagem.registros) {
    const d = dataInclusao(r);
    if (d === null) continue;
    if (d < corteIso) antes++;
    if (maisAntigo === null || d < maisAntigo) maisAntigo = d;
  }
  const res: ResumoLeitura = {
    paginas: listagem.paginas,
    total_de_registros: listagem.total_de_registros,
    presentes: listagem.presentes.length,
    completa: listagem.completa,
    motivos_incompleta: listagem.motivos_incompleta,
    admitidos_pelo_corte: lote.admitidos_pelo_corte,
    fora_do_corte: lote.fora_do_corte,
    sem_data_inclusao: lote.sem_data_inclusao,
    dinc_antes_do_corte: antes,
    dinc_mais_antigo: maisAntigo,
    linhas: 0,
    linhas_sem_codigo_item: 0,
    linhas_sem_codigo_produto: 0,
    linhas_sem_quantidade: 0,
    linhas_sem_unidade: 0,
    linhas_com_ean: 0,
    pedidos_sem_itens: 0,
    bytes_do_lote: new TextEncoder().encode(JSON.stringify(lote.pedidos)).length,
  };
  for (const p of lote.pedidos) {
    if (p.itens.length === 0) res.pedidos_sem_itens++;
    for (const i of p.itens) {
      res.linhas++;
      if (i.codigo_item === null) res.linhas_sem_codigo_item++;
      if (i.codigo_produto === null) res.linhas_sem_codigo_produto++;
      if (i.quantidade === null) res.linhas_sem_quantidade++;
      if (i.unidade === null) res.linhas_sem_unidade++;
      if (i.ean !== null) res.linhas_com_ean++;
    }
  }
  return res;
}

/**
 * Prova do filtro de data: os pedidos mais RECENTES da etapa 10 (listagem SEM filtro) com `dInc`
 * no corte têm de estar todos na listagem filtrada. `perdidos_pelo_filtro` > 0 = o filtro não serve
 * para admitir (corta por outra data). É EVIDÊNCIA AMOSTRAL, não prova universal: só vale com a
 * amostra alcançando `dInc` anterior ao corte (`amostra_cobre_a_janela`), a ordem por código
 * MEDIDA crescente (`amostra_ordem`) e casos elegíveis (`amostra_no_corte` > 0).
 *
 * A amostra são as ÚLTIMAS páginas na ordem padrão, não a 1ª com `ordem_descrescente`: medido em
 * produção (2026-10-12, v0.4), o Omie ordena SÓ DENTRO da página — a 1ª página "decrescente" eram
 * os 100 pedidos MAIS ANTIGOS (dInc 2024/2020), com `amostra_no_corte` = 0 nas duas contas.
 * Por isso a ordem é MEDIDA aqui, nunca pedida.
 */
export function conferirFiltro(amostra: unknown[], filtrados: ReadonlySet<string>, corteIso: string) {
  let noCorte = 0;
  let maisAntigo: string | null = null;
  const perdidos: string[] = [];
  for (const r of amostra) {
    const cod = codigoOmie(obj(obj(r)?.cabecalho)?.codigo_pedido);
    const d = dataInclusao(r);
    if (d !== null && (maisAntigo === null || d < maisAntigo)) maisAntigo = d;
    if (cod === null || d === null || d < corteIso) continue;
    noCorte++;
    if (!filtrados.has(cod)) perdidos.push(cod);
  }
  return {
    amostra: amostra.length,
    amostra_ordem: ordemDosCodigos(amostra.map((r) => codigoOmie(obj(obj(r)?.cabecalho)?.codigo_pedido))),
    amostra_no_corte: noCorte,
    perdidos_pelo_filtro: perdidos.length,
    perdidos_amostra: perdidos.slice(0, 10),
    amostra_dinc_mais_antigo: maisAntigo,
    amostra_cobre_a_janela: maisAntigo !== null && maisAntigo < corteIso,
  };
}

/** Ordem MEDIDA dos códigos (estrita); código ausente = `desordenada`. */
export function ordemDosCodigos(codigos: (string | null)[]): "crescente" | "decrescente" | "desordenada" {
  if (codigos.length < 2 || codigos.some((c) => c === null)) return "desordenada";
  const n = codigos.map((c) => BigInt(c as string));
  if (n.every((c, i) => i === 0 || c > n[i - 1])) return "crescente";
  if (n.every((c, i) => i === 0 || c < n[i - 1])) return "decrescente";
  return "desordenada";
}

/** Páginas (de `porPagina`) que formam a cauda da listagem: as duas últimas, em ordem. */
export function paginasDaCauda(total: number, porPagina: number): number[] {
  const ultima = Math.ceil(total / porPagina);
  if (ultima <= 0) return [];
  return ultima === 1 ? [1] : [ultima - 1, ultima];
}

// ─── Escrita (Fase 0.5b) ─────────────────────────────────────────────────────────────────────

/** Tarefa acompanhada como a edge a lê do banco (só o que decide janela e detalhe). */
export interface Acompanhada {
  omie_codigo_pedido: string;
  status: string;
  fora_da_etapa_em: string | null;
  incluido_em: string | null;
  ausente_rodadas: number;
}

/** Ausente em tantas coletas completas seguidas sai do cálculo da janela (segue BLOQUEADA). */
export const AUSENCIAS_PARA_SAIR_DA_JANELA = 10;

/**
 * 1º dia da listagem: o corte de admissão, ou a inclusão da tarefa ABERTA mais antiga — assim a
 * acompanhada nunca some da listagem por idade (o corte decide só a ADMISSÃO). Aberta = não
 * interrompida, sem saída confirmada e ausente há menos de N coletas: a que sumiu há muito não
 * segura a janela no passado (se reaparecer e a listagem não a vir, ela só continua bloqueada —
 * o erro possível é para o lado seguro). `incluido_em` NULL numa aberta = sem garantia → null
 * (quem chama aborta a rodada).
 */
export function janelaDaListagem(corteIso: string, acompanhadas: Acompanhada[]): string | null {
  let janela = corteIso;
  for (const a of acompanhadas) {
    if (a.status === "interrompida_externa" || a.fora_da_etapa_em !== null) continue;
    if (a.ausente_rodadas >= AUSENCIAS_PARA_SAIR_DA_JANELA) continue;
    if (a.incluido_em === null) return null;
    if (a.incluido_em < janela) janela = a.incluido_em;
  }
  return janela;
}

interface LoteSync {
  p_presentes: number[];
  p_total_de_registros: number;
  p_pedidos: PedidoNormalizado[];
  p_confirmados_fora: number[];
  p_listagem_suspeita: boolean;
  admitidos_pelo_corte: number;
  acompanhados_presentes: number;
  fora_do_corte: number;
}

/**
 * Argumentos de `picking_sincronizar_fila` a partir da listagem. `null` = listagem sem total
 * legível (não há como afirmar completude nem mandar o total — a rodada aborta). Os presentes vão
 * COM a repetição entre páginas; qualquer motivo de incompletude vira `p_listagem_suspeita`
 * (veta a ausência no banco). Sem ConsultarPedido nesta fase: `p_confirmados_fora` vazio.
 */
export function montarLoteSync(listagem: Listagem, corteIso: string, acompanhados: ReadonlySet<string>): LoteSync | null {
  if (listagem.total_de_registros === null) return null;
  const lote = montarLote(listagem.registros, corteIso, acompanhados);
  return {
    p_presentes: listagem.presentes.map(Number),
    p_total_de_registros: listagem.total_de_registros,
    p_pedidos: lote.pedidos,
    p_confirmados_fora: [],
    p_listagem_suspeita: !listagem.completa,
    admitidos_pelo_corte: lote.admitidos_pelo_corte,
    acompanhados_presentes: lote.acompanhados_presentes,
    fora_do_corte: lote.fora_do_corte,
  };
}
