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

// Normaliza e acumula uma página do ListarPosEstoque no Map (dedupe last-wins por código —
// código repetido no MESMO statement de upsert daria 21000 "cannot affect row a second time").
// ⚠️ Os `?? 0` são fabricação CONSCIENTE preservada do N+1: a posição VEIO na resposta do
// Omie; campo ausente = posição zerada, não "dado indisponível". O gate money-path real é o
// cmc>0 nos writers de custo (custo zero nunca vira product_costs).
export function acumularPosicoesDaPagina(
  posicoes: Map<number, PosicaoEstoque>,
  produtos: ItemPosEstoqueOmie[],
): number {
  let validos = 0;
  for (const prod of produtos) {
    const codProd = Number(prod.nCodProd); // Omie pode devolver string; chave do Map é number
    if (!Number.isSafeInteger(codProd) || codProd <= 0) continue;
    const saldo = Number(prod.nSaldo ?? 0);
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
