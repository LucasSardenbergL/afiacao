// Conversão da quantidade do pedido (unidade do Omie) para a unidade que o portal Sayerlack aceita —
// FONTE DA VERDADE do helper puro (vitest em ./__tests__/qtde-portal.test.ts).
//
// ESPELHO: a edge `supabase/functions/enviar-pedido-portal-sayerlack/qtde-portal.ts` carrega este bloco MIRROR
// verbatim (Deno não importa de `src/`). Paridade textual + gate de forma da edge em
// ./__tests__/qtde-portal-edge-invariants.test.ts (CI `validate`). Edite AQUI e copie para lá.
// Só a edge usa este código no caminho vivo; a UI usa `fator_embalagem_portal` apenas como badge.

// MIRROR-START qtde-portal — FONTE da verdade; cópia verbatim na edge enviar-pedido-portal-sayerlack/qtde-portal.ts
// `fator_conversao` (sku_fornecedor_externo) = unidades do PORTAL por unidade do OMIE.
//   - fator 1  → mesma unidade (padrão; concentrados QT/GL já saem do motor em embalagens);
//   - fator 0,2 → Omie em LITRO, portal em BALDE de 5 L (TINGIMIX TEH.3505.00BB: 36 L → 8 BB).
//
// O portal só aceita inteiros → arredonda SEMPRE para cima (nunca sub-pedir). O `round6` antes do
// `ceil` mata a poeira binária de `q * f` (ex.: 0,2 não é exato em IEEE-754): sem ele um múltiplo
// exato pode virar 7,000000000000001 → ceil 8 → um balde a mais no fornecedor, sem desfazer.
//
// Fail-CLOSED: fator não-finito, ≤ 0 ou ≥ FATOR_MAX lança — o chamador aborta o envio do pedido INTEIRO
// (efeito irreversível: o fornecedor recebe de verdade). Antes, `Math.max(1, NaN)` = NaN ia parar
// no input do portal como texto "NaN".

// Bound de finitude ESPELHADO do SQL: o CHECK `fator_positivo` de sku_fornecedor_externo e a CTE `portal_fator`
// do motor exigem `fator_conversao < 1e9` (em numeric, NaN e Infinity ordenam ACIMA de todo número — `> 0`
// sozinho NÃO os fecha). A edge tem de recusar o MESMO conjunto, senão um valor que o banco recusaria na
// escrita passa aqui na leitura (Codex 2026-09-05, achado 3).
export const FATOR_MAX = 1e9;

function fatorValido(fator: unknown): fator is number {
  return typeof fator === "number" && Number.isFinite(fator) && fator > 0 && fator < FATOR_MAX;
}

export class FatorConversaoInvalidoError extends Error {
  constructor(readonly fator: unknown, readonly sku: string) {
    super(`fator_conversao inválido (${String(fator)}) para ${sku} — corrija em sku_fornecedor_externo`);
    this.name = "FatorConversaoInvalidoError";
  }
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function qtdePortal(qtdeFinal: number, fator: number, sku = "?"): number {
  if (!fatorValido(fator)) throw new FatorConversaoInvalidoError(fator, sku);
  const q = Number(qtdeFinal);
  if (!Number.isFinite(q)) throw new FatorConversaoInvalidoError(`qtde_final=${String(qtdeFinal)}`, sku);
  return Math.max(1, Math.ceil(round6(q * fator)));
}

// Inverso: quantas unidades do OMIE a compra FÍSICA representa (8 BB × 5 L = 40 L). É o que `qtde_final`
// tem de passar a valer ANTES de qualquer efeito externo (Codex P0, 2026-09-04): a captura de custo do
// portal faz `total ÷ qtde_final` — com 36 L no item e 8 BB no portal, o preço/L sai inflado e o Omie
// recebe 36 × preço falso. Portal e Omie têm de enxergar a MESMA compra: 40 L ↔ 8 BB.
export function qtdeFisicaOmie(qtdePortalInteira: number, fator: number, sku = "?"): number {
  if (!fatorValido(fator)) throw new FatorConversaoInvalidoError(fator, sku);
  if (!(Number.isInteger(qtdePortalInteira) && qtdePortalInteira >= 1)) {
    throw new FatorConversaoInvalidoError(`qtde_portal=${String(qtdePortalInteira)}`, sku);
  }
  return round6(qtdePortalInteira / fator);
}

// ── TOCTOU aprovação → envio (Codex 2026-09-05, achado 1) ──
// O motor (gerar_pedidos_sugeridos_ciclo, #2157) grava `qtde_final` já no múltiplo da embalagem e persiste o
// fator usado em `pedido_compra_item.fator_embalagem_portal` (NULL = não arredondou). O comprador aprova
// "40 L = 8 baldes" com ESSE fator. Se `sku_fornecedor_externo.fator_conversao` mudar entre a aprovação e o
// envio (0,2 → 0,18), a edge — que relê o fator VIVO — compraria ceil(40×0,18)=8 BB e normalizaria para
// 44,44 L: uma compra que ninguém aprovou. Regra: fator aprovado presente E diferente do vivo → recusar o
// pedido INTEIRO antes de qualquer efeito externo; o ciclo seguinte regrava e o comprador reaprova.
// Igualdade EXATA, sem epsilon (challenge Codex 2026-09-05, P1): aprovado e vivo vêm do MESMO `numeric` (o motor
// copia fator_conversao na mesma transação) → mesmo `Number`, zero falso positivo. Já uma tolerância de 1e-9
// deixava passar mudança REAL: 0,2 → 0,2000000009 com 1.000 L troca 200 por 201 embalagens.
export class FatorAprovadoDivergenteError extends Error {
  constructor(readonly fatorAprovado: unknown, readonly fatorVivo: number, readonly sku: string) {
    super(
      `fator_conversao de ${sku} mudou entre a aprovação e o envio (aprovado ${String(fatorAprovado)}, vivo ${String(fatorVivo)}) ` +
        `— o pedido NÃO foi enviado; aguarde o ciclo regravar as quantidades e reaprove`,
    );
    this.name = "FatorAprovadoDivergenteError";
  }
}

export function verificarFatorAprovado(fatorAprovado: number | string | null | undefined, fatorVivo: number, sku = "?"): void {
  if (fatorAprovado === null || fatorAprovado === undefined) return; // motor não arredondou: nada a conferir
  // numeric do PostgREST chega como string; '' e lixo viram NaN e caem no fail-closed abaixo.
  const aprovado = typeof fatorAprovado === "string" && fatorAprovado.trim() === "" ? Number.NaN : Number(fatorAprovado);
  if (!fatorValido(aprovado) || aprovado !== fatorVivo) {
    throw new FatorAprovadoDivergenteError(fatorAprovado, fatorVivo, sku);
  }
}

// ── Chave de fornecedor (Codex 2026-09-05, achado 2) ──
// O motor casa `sku_fornecedor_externo.fornecedor_nome = sku_parametros.fornecedor_nome` (igualdade exata,
// precisão > recall). A edge casava `ILIKE '%SAYERLACK%'` e indexava num Map last-wins: com um alias do
// fornecedor cadastrado, o Map podia escolher OUTRO fator/SKU do que o motor usou. Agora a edge filtra pela
// chave exata do pedido e, se ainda assim houver >1 linha ATIVA para o mesmo sku_omie, recusa por
// ambiguidade — nunca decide por ordem de chegada. Inativa só fica quando não há ativa (o chamador recusa
// por "sem mapeamento ativo", com o motivo certo).
export class MapeamentoAmbiguoError extends Error {
  constructor(readonly sku: string, readonly n: number) {
    super(`mapeamento ambíguo para ${sku}: ${n} linhas ATIVAS em sku_fornecedor_externo — deixe exatamente 1 ativa`);
    this.name = "MapeamentoAmbiguoError";
  }
}

export function indexarMapeamentos<T extends { sku_omie: string; ativo: boolean | null }>(rows: readonly T[]): Map<string, T> {
  const ativasPorSku = new Map<string, number>();
  const idx = new Map<string, T>();
  for (const r of rows) {
    if (r.ativo === true) {
      const n = (ativasPorSku.get(r.sku_omie) ?? 0) + 1;
      ativasPorSku.set(r.sku_omie, n);
      if (n > 1) throw new MapeamentoAmbiguoError(r.sku_omie, n);
      idx.set(r.sku_omie, r); // ativa vence qualquer inativa já indexada
    } else if (!idx.has(r.sku_omie)) {
      idx.set(r.sku_omie, r);
    }
  }
  return idx;
}
// MIRROR-END qtde-portal
