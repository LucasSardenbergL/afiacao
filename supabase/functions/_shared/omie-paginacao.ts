// Guards PUROS de paginação do ListarPosEstoque do Omie (nTotPaginas) — compartilhados por
// sync-reprocess (reprocessInventory, #1341/#1353) e omie-analytics-sync (syncInventory /
// syncInventoryFull). Testes: omie-paginacao_test.ts. Nasceram em sync-reprocess/inventory-lote.ts
// e subiram p/ _shared/ (padrão product-idmap do #1341) em vez de import cross-edge, que
// acoplaria os bundles de deploy das duas edges.
//
// Por quê: nTotPaginas do Omie é PISO, não verdade (docs/agent/sync.md), e o padrão histórico
// `totalPaginas = result.nTotPaginas || 1` POR RESPOSTA tem dois defeitos:
// (a) resposta intermediária SEM o campo encolhe o teto e o loop completa retrato PARCIAL
//     como 'complete' (Codex P1 do #1353);
// (b) nTotPaginas lixo/gigante gira a edge por ~90s+ de chamadas Omie antes de um guard de
//     CONTAGEM disparar — reproduzindo o próprio 546 (Codex P1 do #1341).

// Guard anti-runaway: nTotPaginas lixo/gigante não pode girar a edge por horas.
// 500 páginas × 100 = 50k posições ≈ >10× o maior uso atual (syncInventoryFull colacor com
// cExibeTodos:"S" ≈ 43 páginas do catálogo ~4.3k; só-com-saldo: oben ~8 págs, colacor ~14).
export const MAX_PAGINAS_POS_ESTOQUE = 500;

// Valida o nTotPaginas DECLARADO na resposta — fail-FAST (Codex P1): um nTotPaginas lixo
// gigante (ex.: 100000) não pode ser descoberto só na página maxPaginas+1, depois de ~90s de
// chamadas Omie — isso reproduziria o próprio 546. Lixo não-inteiro/0/negativo degrada para 1
// (fiel ao `|| 1` histórico: processa a página que JÁ veio e para).
export function validarTotalPaginas(nTot: number | undefined, maxPaginas: number): number {
  const total = Number(nTot ?? 1);
  if (!Number.isSafeInteger(total) || total < 1) return 1;
  if (total > maxPaginas) {
    throw new Error(
      `nTotPaginas=${total} acima do teto anti-runaway (${maxPaginas}) — abortando fail-fast antes de paginar`,
    );
  }
  return total;
}

// Piso MONOTÔNICO do total declarado (Codex P1 do #1353): o total é piso da RUN inteira —
// uma resposta intermediária SEM total (degrada p/ 1 pelo `|| 1` histórico) encolhia o teto
// e o loop completava retrato PARCIAL como 'complete' (ex.: p1 declara 5, p2 vem sem o campo
// → run terminava em 2/5). Declaração nova só MANTÉM ou CRESCE o teto; o fail-fast do
// anti-runaway continua o de validarTotalPaginas.
export function proximoTotalPaginas(
  atual: number,
  declarado: number | undefined,
  maxPaginas: number,
): number {
  return Math.max(atual, validarTotalPaginas(declarado, maxPaginas));
}

export type VeredictoPagina = "processar" | "fim" | "anomalia";

// nTotPaginas do Omie é PISO, não verdade (docs/agent/sync.md): página vazia ANTES do fim
// declarado = fault transiente/rate-limit disfarçado — completar aqui deixaria a cauda stale
// com 'complete' mentindo → anomalia (o caller aborta fail-closed; o próximo ciclo tenta).
// Vazia NA última declarada (ou além) = fim normal.
export function avaliarPagina(nItens: number, pagina: number, totalPaginas: number): VeredictoPagina {
  if (nItens > 0) return "processar";
  return pagina < totalPaginas ? "anomalia" : "fim";
}

// O que os guards acima NÃO cobrem: `nTotPaginas` é PISO (o Omie SUB-REPORTA em listas
// grandes — docs/agent/sync.md), e um laço `while (pagina <= totalPaginas)` para no total
// DECLARADO. Se ele veio curto, a cauda nunca é pedida e o laço termina sem nenhuma
// anomalia — "acabou" e "truncou" ficam indistinguíveis (money-path §8). O segundo sinal
// que os separa é a CONTAGEM de registros que a própria resposta declara (nTotRegistros /
// total_de_registros): lidos < declarados ⇒ retrato truncado.
//
// Por que devolver um booleano em vez de lançar: o caller decide o que fazer com um retrato
// parcial, e a decisão é por EFEITO. Gravar o que leu costuma ser certo (o físico lido está
// fresco); tomar decisão NEGATIVA sobre o que faltou — inativar SKU, apagar órfão, carimbar
// "não comprou" — é sempre errado, porque o ausente é "não li", não "não existe".
// Declarado ausente/0 devolve false: sem o segundo sinal não há como afirmar truncamento
// (e afirmar sem sinal seria fabricar o próprio alerta).
export function varreduraTruncada(registrosLidos: number, totalDeclarado: number | undefined): boolean {
  const declarado = Number(totalDeclarado ?? 0);
  if (!Number.isFinite(declarado) || declarado <= 0) return false;
  return registrosLidos < declarado;
}
