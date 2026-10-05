// I/O do "zero com dono" (lógica pura em zeramento-estoque.ts): loaders KEYSET das linhas locais
// com saldo/estoque ≠ 0, a chamada de confirmação ao Omie e o UPDATE com CAS. Testes:
// zeramento-estoque-io_test.ts. Usado pelo syncInventory (omie-analytics-sync) e pelo
// reprocessInventory (sync-reprocess), DEPOIS de gravarem as posições listadas.
//
// - KEYSET, não offset: o filtro é sobre saldo/estoque, que o próprio sync de 30 min reescreve — com
//   offset, linha que entra no recorte entre páginas devolve a anterior DUPLICADA. O helper LANÇA em
//   página que falha: lista vazia por falha de transporte pareceria "ninguém a zerar".
// - UPDATE, nunca upsert: o upsert de linha completa podia restaurar codigo/descricao lidos antes e
//   apagar um positivo gravado depois da leitura (Codex no desenho). O CAS é a VERSÃO lida (synced_at
//   da posição, updated_at do catálogo) + valor ≠ 0: a linha só muda se ninguém a escreveu depois da
//   leitura; a que outro writer regravou fica (conta como recusada).
import { mensagemDeErro } from "./erro-mensagem.ts";
import { type BancoPostgrest, fetchAllKeyset } from "./paginate.ts";
import {
  type AtualizacaoEstoque,
  type AtualizacaoPosicao,
  type CompletudeListagem,
  espelhosDaMesmaConta,
  interpretarConfirmacao,
  type LinhaEstoqueLocal,
  type LinhaPosicaoLocal,
  MAX_PAGINAS_CONFIRMACAO,
  montarPedidosConfirmacao,
  planejarCandidatos,
  planejarEscritaConfirmada,
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
  confirmadosZero: number;
  naoZero: number;
  desconhecidos: number;
  posicoesZeradas: number;
  estoqueZerado: number;
  recusadosCas: number;
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

function descreverErro(prefixo: string, error: { message: string; code?: string | null }): string {
  return `${prefixo}: ${error.code ?? "sem código"} ${String(error.message).slice(0, 160)}`;
}

// Uma linha por UPDATE (o CAS é por linha). Conta só o que o banco DEVOLVEU como alterado.
export async function aplicarEscritaConfirmada(
  db: EscritorPostgrest,
  empresa: string | null,
  plano: { posicoes: AtualizacaoPosicao[]; estoque: AtualizacaoEstoque[] },
): Promise<{ posicoesZeradas: number; estoqueZerado: number; recusadosCas: number; falhas: string[] }> {
  let posicoesZeradas = 0;
  let estoqueZerado = 0;
  let recusadosCas = 0;
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
  }

  if (empresa !== null) {
    for (const u of plano.estoque) {
      const { data, error } = await db.from("omie_products")
        .update(u.set)
        .eq("id", u.id)
        .eq("account", empresa)
        .neq("estoque", 0)
        .eq("updated_at", u.casUpdatedAt)
        .select("id");
      if (error) falhas.push(descreverErro(`omie_products ${u.omie_codigo_produto}`, error));
      else if (!Array.isArray(data)) falhas.push(`omie_products ${u.omie_codigo_produto}: resposta malformada`);
      else if (data.length === 0) recusadosCas++;
      else estoqueZerado += data.length;
    }
  }
  return { posicoesZeradas, estoqueZerado, recusadosCas, falhas };
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
  const estoqueLocal = d.empresa === null ? [] : await carregarEstoqueLocalNaoZero(d.leitor, d.empresa);
  const plano = planejarCandidatos({ listados: d.listados, completude: d.completude, posicoesLocais, estoqueLocal });
  const resultado: ResultadoZeramento = {
    candidatos: plano.candidatos,
    confirmadosZero: 0,
    naoZero: 0,
    desconhecidos: 0,
    posicoesZeradas: 0,
    estoqueZerado: 0,
    recusadosCas: 0,
    chamadasConfirmacao: 0,
    estranhosNaConfirmacao: 0,
    pulado: plano.pulado,
    falhas: [],
  };
  if (plano.aConfirmar.length === 0) return resultado;

  // A resposta é PAGINADA (uma entrada por local): o lote só vale com a paginação TERMINADA numa
  // página curta. Página que falha, resposta sem lista ou teto de páginas = lote inteiro desconhecido
  // (Codex P1 no adversarial: decidir pela página 1 zerava produto com saldo em outro local).
  const itens: unknown[] = [];
  const incompletos = new Set<number>();
  for (const pedido of montarPedidosConfirmacao(plano.aConfirmar, d.dataPosicao)) {
    const codigos = (pedido.lista_produtos as Array<{ nCodProd: number }>).map((x) => x.nCodProd);
    const porPagina = Number(pedido.nRegPorPagina);
    const doLote: unknown[] = [];
    let terminou = false;
    for (let pagina = 1; pagina <= MAX_PAGINAS_CONFIRMACAO; pagina++) {
      resultado.chamadasConfirmacao++;
      let produtos: unknown[];
      try {
        const resposta = (await d.chamarOmie({ ...pedido, nPagina: pagina })) as { produtos?: unknown } | null;
        if (resposta == null || !Array.isArray(resposta.produtos)) {
          resultado.falhas.push(`confirmação (página ${pagina}): resposta sem lista de produtos`);
          break;
        }
        produtos = resposta.produtos;
      } catch (e) {
        resultado.falhas.push(`confirmação (página ${pagina}): ${(mensagemDeErro(e) ?? "erro sem mensagem utilizável").slice(0, 200)}`);
        break;
      }
      doLote.push(...produtos);
      if (produtos.length < porPagina) {
        terminou = true;
        break;
      }
    }
    if (terminou) itens.push(...doLote);
    else for (const c of codigos) incompletos.add(c);
  }

  const { porCodigo, estranhos } = interpretarConfirmacao(plano.aConfirmar, itens, incompletos);
  resultado.estranhosNaConfirmacao = estranhos;
  for (const c of porCodigo.values()) {
    if (c.tipo === "zero") resultado.confirmadosZero++;
    else if (c.tipo === "nao_zero") resultado.naoZero++;
    else resultado.desconhecidos++;
  }

  const escrita = planejarEscritaConfirmada({ posicoesLocais, estoqueLocal, confirmacoes: porCodigo, nowIso: d.nowIso });
  const aplicado = await aplicarEscritaConfirmada(d.escritor, d.empresa, escrita);
  resultado.posicoesZeradas = aplicado.posicoesZeradas;
  resultado.estoqueZerado = aplicado.estoqueZerado;
  resultado.recusadosCas = aplicado.recusadosCas;
  resultado.falhas.push(...aplicado.falhas);
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
    zeramento_confirmados_zero: r.confirmadosZero,
    zeramento_nao_zero: r.naoZero,
    zeramento_desconhecidos: r.desconhecidos,
    zerados_posicao: r.posicoesZeradas,
    zerados_estoque: r.estoqueZerado,
    zeramento_recusados_cas: r.recusadosCas,
    zeramento_chamadas: r.chamadasConfirmacao,
    zeramento_estranhos: r.estranhosNaConfirmacao,
    ...(r.pulado ? { zeramento_pulado: r.pulado } : {}),
    ...(r.falhas.length > 0 ? { zeramento_falhas: r.falhas.slice(0, 5), zeramento_falhas_total: r.falhas.length } : {}),
  };
}
