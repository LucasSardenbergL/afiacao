// I/O do "zero com dono" (lógica pura em zeramento-estoque.ts): loaders KEYSET das linhas locais
// com saldo/estoque ≠ 0, a chamada de confirmação ao Omie e o UPDATE com CAS. Testes:
// zeramento-estoque-io_test.ts. Usado pelo syncInventory (omie-analytics-sync) e pelo
// reprocessInventory (sync-reprocess), DEPOIS de gravarem as posições listadas.
//
// - KEYSET, não offset: o filtro é sobre saldo/estoque, que o próprio sync de 30 min reescreve — com
//   offset, linha que entra no recorte entre páginas devolve a anterior DUPLICADA. O helper LANÇA em
//   página que falha: lista vazia por falha de transporte pareceria "ninguém a zerar".
// - Trilha NULL (`omie_products.estoque IS NULL` = saldo desconhecido do produto novo): loader e CAS
//   PRÓPRIOS com `.is("estoque", null)` — o `NOT (estoque = 0)` e o `estoque <> 0` são cegos a NULL, e
//   `.or()` num UPDATE do PostgREST dá 42703 (CLAUDE.md §PostgREST).
// - UPDATE, nunca upsert: o upsert de linha completa podia restaurar codigo/descricao lidos antes e
//   apagar um positivo gravado depois da leitura (Codex no desenho). O CAS é a VERSÃO lida (synced_at
//   da posição, updated_at do catálogo) + valor ≠ 0: a linha só muda se ninguém a escreveu depois da
//   leitura; a que outro writer regravou fica (conta como recusada).
import { mensagemDeErro } from "./erro-mensagem.ts";
import { codigoExplicito, numeroExplicito } from "./pos-estoque.ts";
import { type BancoPostgrest, fetchAllKeyset } from "./paginate.ts";
import {
  type AtualizacaoEstoque,
  type AtualizacaoPosicao,
  type CompletudeListagem,
  type Confirmacao,
  espelhosDaMesmaConta,
  interpretarConfirmacao,
  type LinhaEstoqueLocal,
  type LinhaPosicaoLocal,
  MAX_PAGINAS_CONFIRMACAO,
  montarPedidosConfirmacao,
  planejarCandidatos,
  planejarEscritaConfirmada,
  rodadaDoRelogio,
} from "./zeramento-estoque.ts";

interface RespostaEscrita {
  data: unknown[] | null;
  error: { message: string; code?: string | null } | null;
}

interface FiltroEscrita {
  eq(coluna: string, valor: unknown): FiltroEscrita;
  neq(coluna: string, valor: unknown): FiltroEscrita;
  is(coluna: string, valor: null): FiltroEscrita;
  select(colunas: string): PromiseLike<RespostaEscrita>;
}

/** O pedaço do supabase-js que o UPDATE com CAS usa (o `BancoPostgrest` de paginate.ts só lê). */
export interface EscritorPostgrest {
  from(tabela: string): { update(valores: Record<string, unknown>): FiltroEscrita };
}

export interface ResultadoZeramento {
  candidatos: number;
  /** null = a trilha NULL não foi apurada (o loader dela falhou; a ≠ 0 seguiu). */
  candidatosNulos: number | null;
  puladoNulos: string | null;
  confirmadosZero: number;
  naoZero: number;
  desconhecidos: number;
  posicoesZeradas: number;
  estoqueZerado: number;
  /** Subconjunto de `estoqueZerado` cujo valor lido era NULL (nunca somar os dois). */
  estoqueZeradoNulo: number;
  recusadosCas: number;
  /** Catálogo NÃO tentado porque o espelho de posição do mesmo código não foi escrito (≠ recusa de CAS). */
  catalogoAdiado: number;
  chamadasConfirmacao: number;
  estranhosNaConfirmacao: number;
  pulado: string | null;
  falhas: string[];
}

type PosicaoComId = LinhaPosicaoLocal & { id: string };
type EstoqueComId = LinhaEstoqueLocal & { id: string };

export async function carregarPosicoesLocaisNaoZero(db: BancoPostgrest, accounts: string[]): Promise<LinhaPosicaoLocal[]> {
  return await fetchAllKeyset<PosicaoComId, string>(
    (cursor, limite) => {
      let q = db.from<PosicaoComId>("inventory_position")
        .select("id, account, omie_codigo_produto, saldo, cmc, preco_medio, synced_at")
        .in("account", accounts)
        .not("saldo", "eq", 0);
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (l) => l.id,
    "inventory_position (saldo≠0)",
  );
}

export async function carregarEstoqueLocalNaoZero(db: BancoPostgrest, empresa: string): Promise<LinhaEstoqueLocal[]> {
  return await fetchAllKeyset<EstoqueComId, string>(
    (cursor, limite) => {
      let q = db.from<EstoqueComId>("omie_products")
        .select("id, omie_codigo_produto, estoque, updated_at")
        .eq("account", empresa)
        .not("estoque", "eq", 0);
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (l) => l.id,
    "omie_products (estoque≠0)",
  );
}

export async function carregarEstoqueLocalNulo(db: BancoPostgrest, empresa: string): Promise<LinhaEstoqueLocal[]> {
  return await fetchAllKeyset<EstoqueComId, string>(
    (cursor, limite) => {
      let q = db.from<EstoqueComId>("omie_products")
        .select("id, omie_codigo_produto, estoque, updated_at")
        .eq("account", empresa)
        .is("estoque", null);
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (l) => l.id,
    "omie_products (estoque NULL)",
  );
}

function descreverErro(prefixo: string, error: { message: string; code?: string | null }): string {
  return `${prefixo}: ${error.code ?? "sem código"} ${String(error.message).slice(0, 160)}`;
}

// Uma linha por UPDATE (o CAS é por linha). Conta só o que o banco DEVOLVEU como alterado.
export async function aplicarEscritaConfirmada(
  db: EscritorPostgrest,
  empresa: string | null,
  plano: { posicoes: AtualizacaoPosicao[]; estoque: AtualizacaoEstoque[] },
): Promise<{ posicoesZeradas: number; estoqueZerado: number; estoqueZeradoNulo: number; recusadosCas: number; catalogoAdiado: number; falhas: string[] }> {
  let posicoesZeradas = 0;
  let estoqueZerado = 0;
  let estoqueZeradoNulo = 0;
  // Código cujo espelho de posição NÃO foi escrito (CAS recusou ou erro): alguém o regravou depois
  // da confirmação — o catálogo desse código não recebe o zero nesta rodada (Codex P2).
  const posicaoNaoEscrita = new Set<number>();
  let recusadosCas = 0;
  let catalogoAdiado = 0;
  const falhas: string[] = [];

  for (const u of plano.posicoes) {
    let q = db.from("inventory_position")
      .update(u.set)
      .eq("account", u.account)
      .eq("omie_codigo_produto", u.omie_codigo_produto)
      .neq("saldo", 0);
    q = u.casSyncedAt === null ? q.is("synced_at", null) : q.eq("synced_at", u.casSyncedAt);
    const { data, error } = await q.select("omie_codigo_produto");
    if (error) falhas.push(descreverErro(`inventory_position ${u.omie_codigo_produto}`, error));
    else if (!Array.isArray(data)) falhas.push(`inventory_position ${u.omie_codigo_produto}: resposta malformada`);
    else if (data.length === 0) recusadosCas++;
    else posicoesZeradas += data.length;
    if (error || !Array.isArray(data) || data.length === 0) posicaoNaoEscrita.add(u.omie_codigo_produto);
  }

  if (empresa !== null) {
    for (const u of plano.estoque) {
      if (posicaoNaoEscrita.has(u.omie_codigo_produto)) {
        catalogoAdiado++;
        continue;
      }
      const base = db.from("omie_products")
        .update(u.set)
        .eq("id", u.id)
        .eq("account", empresa);
      // CAS do VALOR por trilha: `<> 0` nunca pega NULL, `IS NULL` só pega NULL (sem `.or()`: 42703).
      const { data, error } = await (u.estoqueLidoNulo ? base.is("estoque", null) : base.neq("estoque", 0))
        .eq("updated_at", u.casUpdatedAt)
        .select("id");
      if (error) falhas.push(descreverErro(`omie_products ${u.omie_codigo_produto}`, error));
      else if (!Array.isArray(data)) falhas.push(`omie_products ${u.omie_codigo_produto}: resposta malformada`);
      else if (data.length === 0) recusadosCas++;
      else {
        estoqueZerado += data.length;
        if (u.estoqueLidoNulo) estoqueZeradoNulo += data.length;
      }
    }
  }
  return { posicoesZeradas, estoqueZerado, estoqueZeradoNulo, recusadosCas, catalogoAdiado, falhas };
}

// A resposta de uma página da confirmação que CONTRADIZ o pedido invalida o lote (Codex P1, 2 rodadas).
// Campo AUSENTE não contradiz (o fim continua sendo a página curta); campo PRESENTE que contradiz ou
// que não se consegue ler, sim — é a resposta dizendo algo que o zero não pode ignorar:
// - `nPagina` devolvida ≠ pedida (página repetida: a pedida, onde podia estar o local positivo, não veio);
// - `nRegistros` ≠ itens do array (array declaradamente truncado);
// - página curta com `nTotPaginas` declarando mais páginas;
// - `dDataPosicao` de outro DIA civil, ou ilegível (o retrato pode ser de outro dia).
// `nTotRegistros` é conferido no fim do lote, contra o acumulado (`contradicaoNoFimDoLote`).
export function contradicaoDaResposta(resposta: Record<string, unknown>, pagina: number, porPagina: number, dataPedida: string): string | null {
  const produtos = Array.isArray(resposta.produtos) ? resposta.produtos : [];
  const campo = (k: string): { presente: boolean; n: number | null } =>
    resposta[k] === undefined || resposta[k] === null ? { presente: false, n: null } : { presente: true, n: numeroExplicitoInteiro(resposta[k]) };
  const nPagina = campo("nPagina");
  if (nPagina.presente && nPagina.n !== pagina) return `nPagina devolvida ${String(resposta.nPagina)} ≠ pedida ${pagina} — página repetida ou trocada`;
  const nRegistros = campo("nRegistros");
  if (nRegistros.presente && nRegistros.n !== produtos.length) {
    return `nRegistros=${String(resposta.nRegistros)} mas a página trouxe ${produtos.length} item(ns) — array truncado`;
  }
  const declarado = campo("nTotPaginas");
  if (declarado.presente && declarado.n === null) return `nTotPaginas ilegível (${String(resposta.nTotPaginas).slice(0, 20)})`;
  if (produtos.length < porPagina && declarado.n !== null && declarado.n > pagina) {
    return `página curta (${produtos.length} de ${porPagina}) mas nTotPaginas=${declarado.n} — paginação contraditória`;
  }
  const bruta = resposta.dDataPosicao;
  if (bruta !== undefined && bruta !== null && !(typeof bruta === "string" && bruta.trim() === "")) {
    const devolvida = diaDaData(bruta);
    const pedida = diaDaData(dataPedida);
    if (devolvida === null) return `dDataPosicao devolvida ilegível (${String(bruta).slice(0, 20)})`;
    if (pedida !== null && devolvida !== pedida) return `dDataPosicao devolvida ${String(bruta).trim()} ≠ pedida ${dataPedida}`;
  }
  return null;
}

/** No fim do lote: `nTotRegistros` (quando a última página o traz) tem de bater com o acumulado. */
export function contradicaoNoFimDoLote(ultima: Record<string, unknown>, acumulado: number): string | null {
  const v = ultima.nTotRegistros;
  if (v === undefined || v === null) return null;
  const n = numeroExplicitoInteiro(v);
  return n === acumulado ? null : `nTotRegistros=${String(v).slice(0, 20)} mas o lote acumulou ${acumulado} item(ns)`;
}

/** Dia CIVIL: "DD/MM/AAAA" ou "AAAA-MM-DD" (hora opcional depois) → "AAAA-MM-DD"; outra forma ou dia inexistente → null. */
export function diaDaData(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  const [a, m, d] = br ? [br[3], br[2], br[1]] : iso ? [iso[1], iso[2], iso[3]] : [null, null, null];
  if (a === null || m === null || d === null) return null;
  const dt = new Date(Date.UTC(Number(a), Number(m) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(a) || dt.getUTCMonth() !== Number(m) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return `${a}-${m}-${d}`;
}

function numeroExplicitoInteiro(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// A confirmação de UMA trilha. A resposta é PAGINADA (uma entrada por local): o lote só vale com a
// paginação TERMINADA numa página curta e sem contradição. Página que falha, resposta sem lista,
// contradição ou teto de páginas = lote inteiro desconhecido (Codex P1: decidir pela página 1 zerava
// produto com saldo em outro local). Cada lote AUTORIZA o zero só dos SEUS códigos (o item de outro
// código é estranho; um ilegível só contamina o próprio lote) — mas um saldo explícito ≠ 0 visto em
// QUALQUER resposta da trilha VETA o zero daquele código (Codex P1, 2ª rodada: o lote 2 dizendo 9
// era descartado e o lote 1 zerava).
async function confirmarTrilha(
  d: { chamarOmie: (params: Record<string, unknown>) => Promise<unknown>; dataPosicao: string },
  codigosTrilha: number[],
  resultado: ResultadoZeramento,
): Promise<Map<number, Confirmacao>> {
  const porCodigo = new Map<number, Confirmacao>();
  const vetados = new Set<number>();
  for (const pedido of montarPedidosConfirmacao(codigosTrilha, d.dataPosicao)) {
    const codigos = (pedido.lista_produtos as Array<{ nCodProd: number }>).map((x) => x.nCodProd);
    const porPagina = Number(pedido.nRegPorPagina);
    const doLote: unknown[] = [];
    let terminou = false;
    for (let pagina = 1; pagina <= MAX_PAGINAS_CONFIRMACAO; pagina++) {
      resultado.chamadasConfirmacao++;
      let resposta: Record<string, unknown> & { produtos: unknown[] };
      try {
        const bruta = (await d.chamarOmie({ ...pedido, nPagina: pagina })) as Record<string, unknown> | null;
        if (bruta == null || !Array.isArray(bruta.produtos)) {
          resultado.falhas.push(`confirmação (página ${pagina}): resposta sem lista de produtos`);
          break;
        }
        resposta = bruta as Record<string, unknown> & { produtos: unknown[] };
      } catch (e) {
        resultado.falhas.push(`confirmação (página ${pagina}): ${(mensagemDeErro(e) ?? "erro sem mensagem utilizável").slice(0, 200)}`);
        break;
      }
      for (const cod of codigosComSaldoNaoZero(resposta.produtos)) vetados.add(cod); // veto vale mesmo de página inválida
      const contradicao = contradicaoDaResposta(resposta, pagina, porPagina, String(pedido.dDataPosicao));
      if (contradicao !== null) {
        resultado.falhas.push(`confirmação (página ${pagina}): ${contradicao}`);
        break;
      }
      doLote.push(...resposta.produtos);
      if (resposta.produtos.length < porPagina) {
        const noFim = contradicaoNoFimDoLote(resposta, doLote.length);
        if (noFim !== null) resultado.falhas.push(`confirmação (página ${pagina}): ${noFim}`);
        else terminou = true;
        break;
      }
    }
    const veredito = terminou ? interpretarConfirmacao(codigos, doLote) : interpretarConfirmacao(codigos, [], new Set(codigos));
    resultado.estranhosNaConfirmacao += veredito.estranhos;
    for (const [cod, c] of veredito.porCodigo) porCodigo.set(cod, c);
  }
  for (const cod of vetados) if (porCodigo.get(cod)?.tipo === "zero") porCodigo.set(cod, { tipo: "nao_zero" });
  return porCodigo;
}

function codigosComSaldoNaoZero(itens: unknown[]): number[] {
  const out: number[] = [];
  for (const it of itens) {
    if (typeof it !== "object" || it === null) continue;
    const reg = it as Record<string, unknown>;
    const cod = codigoExplicito(reg.nCodProd);
    const saldo = numeroExplicito(reg.nSaldo);
    if (cod !== null && saldo !== null && saldo !== 0) out.push(cod);
  }
  return out;
}

// O passo inteiro, depois de o writer gravar as posições listadas: descobre os candidatos (posição
// desta conta e estoque desta empresa ≠ 0 fora da listagem), confirma no Omie em lote e escreve só
// os zeros confirmados, com CAS. Loader que falha LANÇA (o caller registra e segue sem zerar);
// falha de confirmação ou de escrita vira `falhas` — os códigos afetados ficam como estão.
export async function zerarConfirmadosForaDaLista(d: {
  leitor: BancoPostgrest;
  escritor: EscritorPostgrest;
  chamarOmie: (params: Record<string, unknown>) => Promise<unknown>;
  /** Rótulo de inventory_position desta rodada; o zero vale para todos os espelhos da mesma conta Omie. */
  account: string;
  /** omie_products.account da mesma conta Omie; null = conta sem catálogo (servicos). */
  empresa: string | null;
  listados: ReadonlySet<number>;
  completude: CompletudeListagem;
  dataPosicao: string;
  nowIso: string;
}): Promise<ResultadoZeramento> {
  const posicoesLocais = await carregarPosicoesLocaisNaoZero(d.leitor, espelhosDaMesmaConta(d.account));
  const estoqueNaoZero = d.empresa === null ? [] : await carregarEstoqueLocalNaoZero(d.leitor, d.empresa);
  // A trilha NULL é ADITIVA: o loader dela falhar não pode cancelar a ≠ 0 já lida (Codex P2) — a
  // falha vai para `falhas` e `candidatosNulos` fica null (não apurado, nunca 0).
  let estoqueNulo: LinhaEstoqueLocal[] = [];
  let falhaNulo: string | null = null;
  if (d.empresa !== null) {
    try {
      estoqueNulo = await carregarEstoqueLocalNulo(d.leitor, d.empresa);
    } catch (e) {
      falhaNulo = `trilha NULL não apurada: ${(mensagemDeErro(e) ?? "erro sem mensagem utilizável").slice(0, 200)}`;
    }
  }
  const estoqueLocal = [...estoqueNaoZero, ...estoqueNulo];
  const plano = planejarCandidatos({
    listados: d.listados,
    completude: d.completude,
    posicoesLocais,
    estoqueLocal,
    rodada: rodadaDoRelogio(d.nowIso),
  });
  const resultado: ResultadoZeramento = {
    candidatos: plano.candidatos,
    candidatosNulos: falhaNulo === null ? plano.candidatosNulos : null,
    puladoNulos: falhaNulo ?? plano.puladoNulos,
    confirmadosZero: 0,
    naoZero: 0,
    desconhecidos: 0,
    posicoesZeradas: 0,
    estoqueZerado: 0,
    estoqueZeradoNulo: 0,
    recusadosCas: 0,
    catalogoAdiado: 0,
    chamadasConfirmacao: 0,
    estranhosNaConfirmacao: 0,
    pulado: plano.pulado,
    falhas: falhaNulo === null ? [] : [falhaNulo],
  };
  if (plano.aConfirmar.length === 0) return resultado;

  // Duas trilhas, lotes e escrita SEPARADOS (Codex P2, 2ª rodada): a ≠ 0 confirma e ESCREVE primeiro —
  // um ilegível num lote NULL não a contamina e um worker que expira na trilha NULL não perde o zero
  // já confirmado da ≠ 0.
  const corte = plano.aConfirmar.length - plano.aConfirmarNulos;
  for (const trilha of [plano.aConfirmar.slice(0, corte), plano.aConfirmar.slice(corte)]) {
    if (trilha.length === 0) continue;
    const porCodigo = await confirmarTrilha(d, trilha, resultado);
    for (const c of porCodigo.values()) {
      if (c.tipo === "zero") resultado.confirmadosZero++;
      else if (c.tipo === "nao_zero") resultado.naoZero++;
      else resultado.desconhecidos++;
    }
    const escrita = planejarEscritaConfirmada({ posicoesLocais, estoqueLocal, confirmacoes: porCodigo, nowIso: d.nowIso });
    const aplicado = await aplicarEscritaConfirmada(d.escritor, d.empresa, escrita);
    resultado.posicoesZeradas += aplicado.posicoesZeradas;
    resultado.estoqueZerado += aplicado.estoqueZerado;
    resultado.estoqueZeradoNulo += aplicado.estoqueZeradoNulo;
    resultado.recusadosCas += aplicado.recusadosCas;
    resultado.catalogoAdiado += aplicado.catalogoAdiado;
    resultado.falhas.push(...aplicado.falhas);
  }
  return resultado;
}

// A metadata do passo, igual nos dois donos (sync_state do analytics, sync_reprocess_log do
// reprocess). `zeramento_candidatos: null` = o passo NÃO apurou (loader falhou) — nunca 0, que
// afirmaria "olhei e não havia ninguém".
export function metadataDoZeramento(
  r: ResultadoZeramento | null,
  erro: string | null,
  pulado: string | null = null,
): Record<string, unknown> {
  if (r === null) {
    return { zeramento_candidatos: null, ...(erro ? { zeramento_erro: erro } : {}), ...(pulado ? { zeramento_pulado: pulado } : {}) };
  }
  return {
    zeramento_candidatos: r.candidatos,
    zeramento_candidatos_nulos: r.candidatosNulos,
    zeramento_confirmados_zero: r.confirmadosZero,
    zeramento_nao_zero: r.naoZero,
    zeramento_desconhecidos: r.desconhecidos,
    zerados_posicao: r.posicoesZeradas,
    zerados_estoque: r.estoqueZerado,
    zerados_estoque_nulo: r.estoqueZeradoNulo,
    zeramento_recusados_cas: r.recusadosCas,
    zeramento_catalogo_adiado: r.catalogoAdiado,
    zeramento_chamadas: r.chamadasConfirmacao,
    zeramento_estranhos: r.estranhosNaConfirmacao,
    ...(r.pulado ? { zeramento_pulado: r.pulado } : {}),
    ...(r.puladoNulos && r.puladoNulos !== r.pulado ? { zeramento_nulos_pulado: r.puladoNulos } : {}),
    ...(r.falhas.length > 0 ? { zeramento_falhas: r.falhas.slice(0, 5), zeramento_falhas_total: r.falhas.length } : {}),
  };
}
