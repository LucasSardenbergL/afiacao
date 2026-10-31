import type { Tables } from "@/integrations/supabase/types";
// Tipos e helpers puros dos Alertas de Outlier (AdminReposicaoAlertas).
// Extraídos de src/pages/AdminReposicaoAlertas.tsx (god-component split).

export const PAGE_SIZE = 25;

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "danger" | "purple" | "indigo";

interface OutlierDetalhes {
  fornecedor?: string;
  mensagem?: string;
  [k: string]: unknown;
}

export type EventoOutlier = {
  id: number;
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  tipo: string;
  severidade: string;
  data_evento: string;
  valor_observado: number | null;
  valor_esperado: number | null;
  desvios_padrao: number | null;
  detalhes: OutlierDetalhes | null;
  status: string;
  decidido_em: string | null;
  decidido_por: string | null;
  justificativa_decisao: string | null;
  detectado_em: string | null;
};

// Fila de ação × Registro. Medido em prod (2026-10-31): toda decisão humana sobre venda atípica foi
// "aceitar" ("Vendas normais"), a última em 22/05, e aceitar não move o motor (spec 2026-07-16) — então
// venda atípica é REGISTRO, não fila. Pedem decisão aqui só o que muda dado: SKU sem grupo (o grupo
// define o LT de produção) e LT atípico (cobrança de fornecedor). Os tipos do Omie têm dono fora daqui:
// o inativado se auto-resolve quando o SKU volta a ficar ativo (omie-sync-status-produtos) e o reativado
// é respondido no Religar/Descontinuar da Revisão de parâmetros.
const TIPOS_FILA = ["sku_sem_grupo", "lt_atipico"] as const;
const TIPOS_REGISTRO = ["venda_atipica", "sku_inativado_omie", "sku_reativado_omie"] as const;

export type Visao = "fila" | "registro";

export const tiposDaVisao = (visao: Visao): readonly string[] =>
  visao === "fila" ? TIPOS_FILA : TIPOS_REGISTRO;

// Onde o reativado se resolve (Religar/Descontinuar). Aceitar aqui fecharia o evento sem a decisão.
export const ROTA_REVISAO_PARAMETROS = "/admin/reposicao/sessao/parametros?tab=ajuste";

export type OutlierStats = {
  semGrupo: number;
  ltAtipico: number;
  ltCriticos: number;
  vendaAtipica: number;
  inativadoOmie: number;
  reativadoOmie: number;
  decididosHoje: number;
};

export type SkuInfo = {
  classe_consolidada: string | null;
  demanda_media_diaria: number | null;
  demanda_sigma_diario: number | null;
  lt_medio_dias_uteis: number | null;
  preco_compra_real: number | null;
};

// Colunas reais de fornecedor_grupo_producao (a coluna é `grupo_codigo`; o nome antigo `codigo_grupo`
// não existia e a query dava 400 escondida por um cast).
export type GrupoRow = Pick<Tables<"fornecedor_grupo_producao">, "id" | "grupo_codigo" | "descricao" | "lt_producao_dias">;

// Sem `tipo`: 'aceitar' virou a única decisão, então o campo não distingue mais nada e
// ninguém o lê. 'excluir' saiu (prometia remover da estatística e nunca alcançou o motor —
// spec 2026-07-16); 'ignorar' saiu junto (arquivava igual a 'aceitar' e nunca foi usado).
// Resta só o que ainda decide layout e alvo: se a confirmação é de lote ou individual.
export type AcaoConfirm = { lote: boolean };

export const tipoLabel = (tipo: string) =>
  tipo === "venda_atipica"
    ? "Venda atípica"
    : tipo === "lt_atipico"
    ? "LT atípico"
    : tipo === "sku_sem_grupo"
    ? "SKU sem grupo"
    : tipo === "sku_inativado_omie"
    ? "Inativado no Omie"
    : tipo === "sku_reativado_omie"
    ? "Reativado no Omie"
    : tipo;

// Dias inteiros desde a detecção — o que estava escondido na tela: alerta "crítico" de abril ainda pendente.
// Sem data → null (ausente ≠ zero: "há 0 dias" seria inventar frescor).
export const idadeDias = (detectadoEm: string | null, agora: Date = new Date()): number | null => {
  if (!detectadoEm) return null;
  const t = new Date(detectadoEm).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((agora.getTime() - t) / 86_400_000));
};

// Selecionável para "marcar como revisado" em lote: pendente, não crítico, e não é tipo que se resolve
// com outra decisão (grupo, ou Religar/Descontinuar).
export const podeAceitarEmLote = (e: Pick<EventoOutlier, "status" | "severidade" | "tipo">) =>
  e.status === "pendente" &&
  e.severidade !== "critico" &&
  e.tipo !== "sku_sem_grupo" &&
  e.tipo !== "sku_reativado_omie";

export const fmt = (n: number | null | undefined, dec = 2) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

// Lote do "atribuir grupo": por empresa+fornecedor (o recálculo é por empresa), maior lote primeiro.
export type LoteSemGrupo = { chave: string; empresa: string; fornecedor: string; eventos: EventoOutlier[] };

export function agruparPorFornecedor(eventos: EventoOutlier[]): LoteSemGrupo[] {
  const mapa = new Map<string, LoteSemGrupo>();
  for (const e of eventos) {
    const fornecedor = e.detalhes?.fornecedor ?? "";
    const chave = `${e.empresa}|${fornecedor}`;
    const lote = mapa.get(chave) ?? { chave, empresa: e.empresa, fornecedor, eventos: [] };
    lote.eventos.push(e);
    mapa.set(chave, lote);
  }
  return Array.from(mapa.values()).sort((a, b) => b.eventos.length - a.eventos.length);
}
