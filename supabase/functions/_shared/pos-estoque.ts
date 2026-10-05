// Normalização PURA das páginas do ListarPosEstoque do Omie — compartilhada por
// sync-reprocess (reprocessInventory) e omie-analytics-sync (syncInventory/syncInventoryFull).
// Testes: pos-estoque_test.ts. Nasceu em sync-reprocess/inventory-lote.ts (#1341) e subiu p/
// _shared/ quando o canônico ganhou a mesma validação (Codex P2 da rodada do canônico:
// nSaldo/nCMC cru no payload numeric → um único item malformado derruba o chunk de 500 com
// 22P02; e acumular em ARRAY sem dedupe → código repetido no mesmo chunk = 21000).

export interface PosicaoEstoque {
  saldo: number;
  cmc: number;
  precoMedio: number;
}

export interface ItemPosEstoqueOmie {
  nCodProd?: number | string;
  nSaldo?: number;
  nCMC?: number;
  nPrecoMedio?: number;
}

// Número EXPLÍCITO de um campo do Omie: number finito ou string numérica não-vazia. undefined,
// null, "", branco, boolean, objeto, NaN e ±Infinity são null — `Number(null)`, `Number("")` e
// `Number("  ")` dão 0, e é assim que um campo ausente virava saldo zero (ausente ≠ zero).
export function numeroExplicito(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Código de produto EXPLÍCITO: inteiro seguro > 0 vindo de number ou de string só de dígitos.
// `Number([7])` é 7 e `Number(true)` é 1 — coagir array/boolean/objeto inventa um código.
export function codigoExplicito(v: unknown): number | null {
  if (typeof v === "string") {
    if (!/^\s*\d+\s*$/.test(v)) return null;
  } else if (typeof v !== "number") {
    return null;
  }
  const cod = Number(v);
  return Number.isSafeInteger(cod) && cod > 0 ? cod : null;
}

// Normaliza e acumula uma página do ListarPosEstoque no Map (dedupe last-wins por código —
// código repetido no MESMO statement de upsert daria 21000 "cannot affect row a second time").
// O SALDO tem de vir explícito: sem ele o item sai do retrato (o código fica fora do Map, e quem
// tem saldo local ≠ 0 vira candidato à confirmação de _shared/zeramento-estoque.ts). Os `?? 0` de
// nCMC/nPrecoMedio seguem a fabricação consciente do N+1 — o gate money-path do custo é o cmc>0
// nos writers de custo (custo zero nunca vira product_costs).
export function acumularPosicoesDaPagina(
  posicoes: Map<number, PosicaoEstoque>,
  produtos: ItemPosEstoqueOmie[],
): number {
  let validos = 0;
  for (const prod of produtos) {
    const codProd = codigoExplicito(prod.nCodProd); // Omie pode devolver string; chave do Map é number
    if (codProd === null) continue;
    const saldo = numeroExplicito(prod.nSaldo);
    if (saldo === null) continue;
    const cmc = Number(prod.nCMC ?? 0);
    const precoMedio = Number(prod.nPrecoMedio ?? 0);
    // Drift de contrato (NaN/±Inf/lixo) descarta o ITEM, não o lote: em chunk de 500 um único
    // valor malformado derrubaria o statement inteiro no Postgres (no N+1 o dano era 1 produto).
    // Nunca clampa lixo para 0 — seria fabricação.
    if (!Number.isFinite(saldo) || !Number.isFinite(cmc) || !Number.isFinite(precoMedio)) continue;
    posicoes.set(codProd, { saldo, cmc, precoMedio });
    validos++;
  }
  return validos;
}
