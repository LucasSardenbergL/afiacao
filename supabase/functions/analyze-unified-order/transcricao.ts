// Modo só-imagem em DOIS PASSOS — o que substitui o "carrega TODOS os perfis e TODO o catálogo".
//
// POR QUE: o modo só-imagem lia `profiles` e `omie_products` com `.limit(1000)` e despejava as
// duas listas no prompt para a IA casar o que via na foto. Prod (psql-ro, 2026-10-10): 5.668
// perfis e 3.223 produtos ativos — a IA enxergava 18% dos clientes e 31% do catálogo, em
// silêncio, e o `error` das duas leituras era descartado ("falhou" virava "nenhum casou").
// Só paginar não conserta: as listas inteiras dão ~1,17M chars (~330k tokens) de prompt, acima
// dos 200k de contexto do `claude-sonnet-4-6` — o modo trocaria "enxerga 18%" por "400 em todo
// pedido". O teto era o EIXO errado (CLAUDE.md, "corte por ranking"): quem sabe qual produto
// importa é a FOTO, não a ordem alfabética. Então:
//
//   passo 1 — a IA TRANSCREVE a foto (cliente + itens), sem catálogo nem lista de clientes;
//   leitura — catálogo e perfis INTEIROS, paginados por keyset, colunas mínimas, fail-closed;
//   ranking — aqui, por item transcrito (e pelo cliente): o top-K de RELEVÂNCIA de cada um;
//   passo 2 — a análise de sempre, com as fotos e só esses candidatos.
//
// O corte por item (top-K) é no eixo da decisão — relevância para AQUELE item —, não um
// `ORDER BY descricao LIMIT n` sobre o catálogo (desenho revisado com o Codex, 2026-10-10:
// `limit` por consulta ordenada por descrição ainda cortaria no eixo errado).
//
// Módulo sem import remoto: a suíte de edge roda `--no-remote`. O banco entra por tipo estrutural.
import { type BancoPostgrest, fetchAllKeyset } from "../_shared/paginate.ts";

/**
 * Teto de itens transcritos. ACIMA dele o caller RECUSA (422, "divida o pedido") — nunca segue
 * com os primeiros N, que seria pedido parcial com cara de completo.
 */
export const MAX_ITENS_TRANSCRITOS = 40;
/** Candidatos de catálogo por item que vão ao passo 2. */
export const TOP_K_POR_ITEM = 8;
/** Candidatos de cliente que vão ao passo 2. */
export const TOP_K_CLIENTES = 15;

export const NOME_TOOL_TRANSCRICAO = "transcrever_pedido";

/** Tool do passo 1. Só TRANSCREVE — não casa com catálogo, não precifica, não inventa. */
export const TOOL_TRANSCRICAO = {
  name: NOME_TOOL_TRANSCRICAO,
  description:
    "Transcreve o que está ESCRITO nas imagens do pedido: o nome do cliente (se aparecer) e TODOS os itens pedidos.",
  input_schema: {
    type: "object" as const,
    properties: {
      cliente: {
        type: ["string", "null"],
        description:
          "Nome do cliente/empresa como aparece na imagem (nome fantasia ou razão social). null se não aparecer.",
      },
      itens: {
        type: "array",
        description: "Um elemento por linha de item pedido, na ordem da imagem. Não omita nenhuma linha.",
        items: {
          type: "object",
          properties: {
            descricao: {
              type: "string",
              description: "Descrição do item como escrita, SEM a quantidade (ex.: 'lixa grão 120 norton').",
            },
            codigo: {
              type: ["string", "null"],
              description: "Código do produto se estiver escrito na imagem (ex.: 'FO05.6717'). null se não houver.",
            },
          },
          required: ["descricao", "codigo"],
        },
      },
    },
    required: ["cliente", "itens"],
  },
};

export interface ItemTranscrito {
  descricao: string;
  codigo: string | null;
}

export interface Transcricao {
  cliente: string | null;
  itens: ItemTranscrito[];
}

function textoOuNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Valida o `input` da tool do passo 1. `null` = forma MALFORMADA (o caller recusa — "a IA não
 * respondeu direito" não pode virar "a foto não tem nada"). Item sem descrição E sem código é
 * descartado (não há o que procurar); lista vazia é legítima (foto sem pedido legível) e segue
 * para o passo 2, que dirá isso ao vendedor.
 */
export function interpretarTranscricao(input: unknown): Transcricao | null {
  if (typeof input !== "object" || input === null) return null;
  const bruto = input as { cliente?: unknown; itens?: unknown };
  if (!Array.isArray(bruto.itens)) return null;
  const itens: ItemTranscrito[] = [];
  for (const cru of bruto.itens) {
    if (typeof cru !== "object" || cru === null) continue;
    const { descricao, codigo } = cru as { descricao?: unknown; codigo?: unknown };
    const d = textoOuNull(descricao);
    const c = textoOuNull(codigo);
    if (d === null && c === null) continue;
    itens.push({ descricao: d ?? "", codigo: c });
  }
  return { cliente: textoOuNull(bruto.cliente), itens };
}

// ── Normalização e pontuação ─────────────────────────────────────────────────

/** Minúsculas, sem acento, só [a-z0-9] separados por espaço. */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Só alfanuméricos — a forma comparável de um código (`FO05.6717` ≡ `fo056717`). */
function compactar(s: string): string {
  return normalizar(s).replace(/ /g, "");
}

const PALAVRAS_VAZIAS = new Set([
  "com", "para", "por", "sem", "dos", "das", "uns", "umas", "und", "unid", "unidade", "unidades",
  "pct", "pcte", "pacote", "caixa", "cxs",
]);

export const PALAVRAS_GENERICAS_CLIENTE = new Set([
  "ltda", "eireli", "epp", "cia", "comercio", "industria", "me",
]);

/** Termos que pontuam: ≥3 caracteres, ou ≥2 se tiver dígito (`p80`, `3m`). */
export function termos(s: string, vazias: ReadonlySet<string> = PALAVRAS_VAZIAS): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const t of normalizar(s).split(" ")) {
    if (t === "" || vazias.has(t) || vistos.has(t)) continue;
    if (t.length < 3 && !(t.length === 2 && /\d/.test(t))) continue;
    vistos.add(t);
    out.push(t);
  }
  return out;
}

interface Indexado<T> {
  linha: T;
  texto: string; // normalizado, com espaços nas bordas para casar palavra inteira
  compacto: string; // texto sem espaços (código dentro da descrição)
  codigo: string; // código compacto ('' se não houver)
}

/**
 * Pontua um termo contra um texto indexado: palavra INTEIRA vale o dobro de SUBSTRING (o OCR
 * que corta uma letra ainda pontua, mas perde para quem bate exato). Peso pelo comprimento —
 * termo longo discrimina mais que termo curto.
 */
function pontuarTermos(ts: readonly string[], ix: Indexado<unknown>): number {
  let s = 0;
  for (const t of ts) {
    if (ix.texto.includes(` ${t} `)) s += 2 * t.length;
    else if (ix.texto.includes(t)) s += t.length;
  }
  return s;
}

/** Código transcrito contra o produto: igual vence tudo; contido (ou na descrição) pontua forte. */
function pontuarCodigo(cod: string, ix: Indexado<unknown>): number {
  if (cod.length < 3) return 0;
  if (ix.codigo !== "" && ix.codigo === cod) return 100;
  if (ix.codigo.length >= 4 && (ix.codigo.includes(cod) || cod.includes(ix.codigo))) return 40;
  // O próprio prompt do passo 2 documenta código comercial DENTRO da descrição.
  if (ix.compacto.includes(cod)) return 30;
  return 0;
}

function topK<T>(
  pontuados: { s: number; ix: Indexado<T> }[],
  k: number,
  desempate: (a: T, b: T) => number,
): T[] {
  return pontuados
    .filter((p) => p.s > 0)
    .sort((a, b) => b.s - a.s || desempate(a.ix.linha, b.ix.linha))
    .slice(0, k)
    .map((p) => p.ix.linha);
}

// ── Produtos ─────────────────────────────────────────────────────────────────

export interface ProdutoCatalogoMinimo {
  id: string;
  codigo: string;
  descricao: string;
  account: string | null;
  valor_unitario: number | null;
  estoque: number | null;
}

export interface ResultadoRanking<T> {
  candidatos: T[];
  /** Itens sem NENHUM candidato com pontuação — o passo 2 os verá na foto sem ter com o que casar. */
  semCandidato: number;
}

/**
 * Top-K de relevância POR ITEM, união deduplicada por id na ordem dos itens. Dedup só remove a
 * repetição do MESMO produto na lista do prompt — dois itens da foto continuam podendo apontar
 * para ele no passo 2.
 */
export function rankearProdutos(
  itens: readonly ItemTranscrito[],
  catalogo: readonly ProdutoCatalogoMinimo[],
  k: number = TOP_K_POR_ITEM,
): ResultadoRanking<ProdutoCatalogoMinimo> {
  const indice: Indexado<ProdutoCatalogoMinimo>[] = catalogo.map((p) => {
    const texto = normalizar(`${p.descricao ?? ""} ${p.codigo ?? ""}`);
    return { linha: p, texto: ` ${texto} `, compacto: texto.replace(/ /g, ""), codigo: compactar(p.codigo ?? "") };
  });
  const desempate = (a: ProdutoCatalogoMinimo, b: ProdutoCatalogoMinimo) =>
    (a.descricao ?? "").localeCompare(b.descricao ?? "") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const vistos = new Set<string>();
  const candidatos: ProdutoCatalogoMinimo[] = [];
  let semCandidato = 0;
  for (const item of itens) {
    const ts = termos(item.descricao);
    const cod = item.codigo ? compactar(item.codigo) : "";
    const melhores = topK(
      indice.map((ix) => ({ s: pontuarTermos(ts, ix) + pontuarCodigo(cod, ix), ix })),
      k,
      desempate,
    );
    if (melhores.length === 0) semCandidato++;
    for (const p of melhores) {
      if (vistos.has(p.id)) continue;
      vistos.add(p.id);
      candidatos.push(p);
    }
  }
  return { candidatos, semCandidato };
}

// ── Clientes ─────────────────────────────────────────────────────────────────

export interface PerfilMinimo {
  user_id: string;
  name: string | null;
  document: string | null;
}

/**
 * Top-K de perfis pelo nome transcrito. Sem nome na foto → nenhum candidato (o passo 2 devolve
 * cliente null e o vendedor escolhe): os 1.000 perfis de antes não eram EVIDÊNCIA de nada.
 * O vendedor logado sai da lista — ele é quem vende, não quem compra.
 */
export function rankearClientes(
  cliente: string | null,
  perfis: readonly PerfilMinimo[],
  excluirUserId: string,
  k: number = TOP_K_CLIENTES,
): PerfilMinimo[] {
  if (!cliente) return [];
  const ts = termos(cliente, PALAVRAS_GENERICAS_CLIENTE);
  if (ts.length === 0) return [];
  const indice: Indexado<PerfilMinimo>[] = perfis
    .filter((p) => p.user_id !== excluirUserId && p.name)
    .map((p) => {
      const texto = normalizar(p.name ?? "");
      return { linha: p, texto: ` ${texto} `, compacto: texto.replace(/ /g, ""), codigo: "" };
    });
  return topK(
    indice.map((ix) => ({ s: pontuarTermos(ts, ix), ix })),
    k,
    (a, b) => (a.name ?? "").localeCompare(b.name ?? "") || (a.user_id < b.user_id ? -1 : 1),
  );
}

// ── Leituras (paginadas, fail-closed) ────────────────────────────────────────
// KEYSET e não offset: `omie_products` tem o `ativo` reescrito pelo cron de status — o filtro do
// recorte muda durante a leitura, e offset pularia/duplicaria (ver `fetchAllKeyset` em
// `_shared/paginate.ts`, que cita esta tabela). `profiles` recebe INSERT de cadastro/import.
// Falha lança `FalhaLeituraCritica` (500 pelo catch geral) — nunca lista vazia.

export function carregarCatalogoAtivo(db: BancoPostgrest): Promise<ProdutoCatalogoMinimo[]> {
  return fetchAllKeyset<ProdutoCatalogoMinimo, string>(
    (cursor, limite) => {
      let q = db.from<ProdutoCatalogoMinimo>("omie_products")
        .select("id, codigo, descricao, account, valor_unitario, estoque")
        .eq("ativo", true);
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (p) => p.id,
    "omie_products (catálogo ativo, modo só-imagem)",
  );
}

export function carregarPerfis(db: BancoPostgrest): Promise<PerfilMinimo[]> {
  return fetchAllKeyset<PerfilMinimo, string>(
    (cursor, limite) => {
      let q = db.from<PerfilMinimo>("profiles").select("user_id, name, document");
      if (cursor !== null) q = q.gt("user_id", cursor);
      return q.order("user_id", { ascending: true }).limit(limite);
    },
    (p) => p.user_id,
    "profiles (clientes, modo só-imagem)",
  );
}
