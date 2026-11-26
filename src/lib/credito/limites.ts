// Lógica pura da tela /credito/limites (crédito-IA PR 4). Sem I/O — testada em limites.test.ts.
//
// A IA PROPÕE, o Lucas aprova. A tela agrupa as pendentes por faixa (risco × tamanho) para a
// aprovação em lote, mostra o limite da IA → o limite pós-trava e, ao lado de cada motivo da IA, o
// VALOR REAL do campo citado (Codex desenho P2-11: separar evidência de texto gerado).

export type Risco = "baixo" | "medio" | "alto" | "sem_evidencia";

type MotivoIA = { campo: string; leitura: string };
type CorteTrava = { trava: string; campo: string; antes: number | string; depois: number | string };

export type PropostaFila = {
  id: string;
  grupo_user_id: string;
  nome: string | null;
  documento: string | null;
  status: string;
  limite_sugerido_brl: number;
  prazo_max_dias: number;
  risco: Risco;
  confianca: number | null;
  ficha: Record<string, unknown>;
  saida_ia: { limite_brl?: number; prazo_max_dias?: number; risco?: string; motivos?: MotivoIA[] } | null;
  travas: CorteTrava[] | null;
  ficha_calculada_em: string;
  created_at: string;
  limite_vigente_brl: number | null;
};

export const TAMANHOS = [
  { id: "zero", rotulo: "Limite zero", ate: 0 },
  { id: "ate_5k", rotulo: "Até R$ 5 mil", ate: 5_000 },
  { id: "ate_20k", rotulo: "R$ 5 mil a R$ 20 mil", ate: 20_000 },
  { id: "acima_20k", rotulo: "Acima de R$ 20 mil", ate: Number.POSITIVE_INFINITY },
] as const;
export type Tamanho = typeof TAMANHOS[number]["id"];

export const ROTULO_RISCO: Record<Risco, string> = {
  baixo: "Risco baixo",
  medio: "Risco médio",
  alto: "Risco alto",
  sem_evidencia: "Sem evidência",
};
const ORDEM_RISCO: Risco[] = ["baixo", "medio", "alto", "sem_evidencia"];

export function tamanhoDe(limite: number): Tamanho {
  return (TAMANHOS.find((t) => limite <= t.ate) ?? TAMANHOS[TAMANHOS.length - 1]).id;
}

export type Faixa = { chave: string; risco: Risco; tamanho: Tamanho; propostas: PropostaFila[]; total_brl: number };

/** Faixas risco × tamanho, na ordem baixo→sem evidência e zero→maior. */
export function agruparPorFaixa(lista: PropostaFila[]): Faixa[] {
  const mapa = new Map<string, Faixa>();
  for (const p of lista) {
    const tamanho = tamanhoDe(p.limite_sugerido_brl);
    const chave = `${p.risco}:${tamanho}`;
    const f = mapa.get(chave) ?? { chave, risco: p.risco, tamanho, propostas: [], total_brl: 0 };
    f.propostas.push(p);
    f.total_brl += p.limite_sugerido_brl;
    mapa.set(chave, f);
  }
  const ordemTam = TAMANHOS.map((t) => t.id as Tamanho);
  return [...mapa.values()].sort((a, b) =>
    ORDEM_RISCO.indexOf(a.risco) - ORDEM_RISCO.indexOf(b.risco) || ordemTam.indexOf(a.tamanho) - ordemTam.indexOf(b.tamanho));
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
export function brl(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? BRL.format(v) : "—";
}

const CAMPOS_BRL = new Set(["vencido_60d_brl", "vencido_15d_brl", "em_aberto_brl", "faturamento_180d_brl",
  "compra_media_mensal_brl", "limite_vigente_brl", "teto_limite_brl"]);
const CAMPOS_DIAS = new Set(["antiguidade_dias", "atraso_p50_dias", "atraso_p80_dias", "maior_prazo_honrado_dias",
  "prazo_vigente_dias", "teto_prazo_dias"]);

/** O valor REAL do campo da ficha que a IA citou — "desconhecido" para null (ausente ≠ zero). */
export function valorCitado(ficha: Record<string, unknown>, campo: string): string {
  if (!(campo in ficha)) return "campo inexistente na ficha";
  const v = ficha[campo];
  if (v === null || v === undefined) return "desconhecido";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "number") {
    if (CAMPOS_BRL.has(campo)) return brl(v);
    if (CAMPOS_DIAS.has(campo)) return `${v} d`;
    if (campo === "pct_valor_atrasado") return `${(v * 100).toFixed(1).replace(".", ",")}%`;
    return String(v);
  }
  return String(v);
}

/** Lotes de ≤ 50 ids (o teto da RPC), deduplicados, na ordem recebida. */
export function emBlocos(ids: string[], tamanho = 50): string[][] {
  const unicos = [...new Set(ids)];
  const blocos: string[][] = [];
  for (let i = 0; i < unicos.length; i += tamanho) blocos.push(unicos.slice(i, i + tamanho));
  return blocos;
}

export type ResultadoLote = { id: string; ok: boolean; versao?: number; sqlstate?: string; erro?: string };

/** Lê a resposta da RPC de lote sem confiar na forma (resposta perdida/estranha ⇒ erro explícito). */
export function lerResultadoLote(bruto: unknown): ResultadoLote[] {
  const r = bruto as { resultados?: unknown } | null;
  if (!r || !Array.isArray(r.resultados)) throw new Error("resposta do lote sem resultados");
  return r.resultados.map((x) => {
    const o = x as Record<string, unknown>;
    if (typeof o?.id !== "string" || typeof o?.ok !== "boolean") throw new Error("resultado do lote malformado");
    return {
      id: o.id, ok: o.ok,
      versao: typeof o.versao === "number" ? o.versao : undefined,
      sqlstate: typeof o.sqlstate === "string" ? o.sqlstate : undefined,
      erro: typeof o.erro === "string" ? o.erro : undefined,
    };
  });
}

/** Motivo legível de uma falha do lote (a marca do ramo vem da RPC). */
export function motivoFalha(r: ResultadoLote): string {
  const e = r.erro ?? "";
  if (e.includes("ficha_vencida")) return "ficha com mais de 14 dias — aguarde a reavaliação";
  if (e.includes("ficha_superada")) return "o cliente piorou desde a ficha — aguarde a reavaliação";
  if (e.includes("grupo_mudou")) return "o grupo mudou desde a proposta";
  if (e.includes("proposta_nao_pendente")) return "já decidida";
  if (e.includes("proposta_desatualizada")) return "o limite vigente mudou";
  return e || "erro desconhecido";
}
