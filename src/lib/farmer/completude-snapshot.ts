/**
 * Completude do SNAPSHOT do motor farmer — o que separa "zero de verdade" de
 * "zero por dado faltando".
 *
 * Por que existe: o #1756 fez o recálculo APOSENTAR a geração anterior, mas só quando
 * ele produz linha. A geração legitimamente VAZIA não movia nada, e o banco seguia
 * servindo as recomendações que o novo cálculo decidiu que não deveriam existir. Para
 * um dia poder expirar por vazio sem zerar a carteira de uma vendedora por causa de uma
 * falha a montante, é preciso saber se o zero veio de um snapshot ÍNTEGRO.
 *
 * Isso não se infere do resultado — só o produtor sabe. Daí a completude ser uma
 * DECLARAÇÃO do motor, e as contagens (`n`) serem a evidência que permite auditá-la:
 * "rótulo com DEFAULT constante não é fato" (money-path §5).
 *
 * ⚠️ O rótulo `completo` é o único que a fase 2 poderá usar para expirar. Por isso a
 * regra fecha em precisão > recall: qualquer dúvida vira `degradado`, e `degradado`
 * nunca autoriza expirar. Errar para `degradado` custa uma oferta velha a mais na tela;
 * errar para `completo` custa a carteira inteira da vendedora.
 */

// Não exportado de propósito: os consumidores montam o snapshot como objeto literal e
// falam em `InsumosSnapshot`. Exportar sem consumidor faz o gate de dead-code (knip)
// reprovar no CI — e o `bun run test` local NÃO cobre esse gate (o health stack sim).
/** Um insumo do snapshot: foi lido com sucesso, e quantas linhas vieram. */
interface InsumoLido {
  /** `false` = a leitura FALHOU (exceção, página perdida, RPC recusada). */
  ok: boolean;
  /** Quantas linhas o insumo devolveu. Só faz sentido quando `ok`. */
  n: number;
  /**
   * Universo de referência do qual `n` é a fatia ÚTIL — declarado só por quem mede
   * COBERTURA, não universo.
   *
   * `n > 0` responde "esse insumo existe?", que não é a pergunta que a fase 2 faz. Um farmer
   * com 101 clientes ativos e 1 perfil produz zero por ter PULADO 100 deles (`if (!profile)
   * continue`), e mesmo assim todos os contadores globais seguem fartos — o head sairia
   * `completo` e autorizaria expirar a carteira.
   */
  esperado?: number;
  /**
   * Fração mínima de `esperado` que `n` precisa alcançar (0..1). Sem ele, `esperado` é só
   * evidência para auditoria e não muda veredicto.
   *
   * Deliberadamente NÃO é uma constante global: o piso é uma afirmação sobre o motor que
   * mede, e um número mágico aqui viraria "rótulo com DEFAULT constante", que o money-path §5
   * proíbe justamente por não ser fato. Cada call-site declara o seu e responde por ele.
   */
  pisoCobertura?: number;
}

export type InsumosSnapshot = Record<string, InsumoLido>;

export type Completude = 'completo' | 'degradado';

export interface VeredictoCompletude {
  completude: Completude;
  /** `null` quando completo; a RPC EXIGE motivo quando degradado (FG104). */
  motivo: string | null;
}

/**
 * Insumos sem os quais o motor de cross-sell não pode concluir "não há o que recomendar".
 *
 * `regras` (associação) NÃO entra AQUI: uma base sem padrão de coocorrência é um estado
 * legítimo para ESTE motor, que segue recomendando por popularidade (`clusterAdherence`).
 * A justificativa é do cross-sell e NÃO se transporta — o bundle não tem caminho por
 * popularidade, e lá `regras` é obrigatório (ver `INSUMOS_OBRIGATORIOS_BUNDLE`). Já
 * `vendaveis` entra mesmo
 * podendo ser legitimamente vazio (todo SKU sem custo conhecido é fail-closed por
 * desenho, #1466) — porque "nenhum SKU rentável em toda a base" é muito mais provável
 * ser custo não calculado do que verdade comercial, e o empate resolve fail-closed.
 */
export const INSUMOS_OBRIGATORIOS_CROSS_SELL = [
  'scores',
  'catalogo',
  'vendaveis',
  'pedidos',
  // `carteira_ativa` (carteira ∩ clientes com pedido) é o universo REAL do cálculo, e é
  // diferente de `pedidos`, que é global. Um farmer cujos clientes nunca compraram tem
  // `pedidos` farto e `carteira_ativa` zero — e aí o zero final não diz nada sobre o
  // portfólio, só que não há histórico de onde tirar coocorrência. Sem separar os dois,
  // esse caso seria rotulado `completo` e viraria licença para expirar.
  'carteira_ativa',
  // COBERTURA, não universo: o motor faz `if (!profile) continue`, então cliente sem
  // perfil é pulado em silêncio. A base tem 1.633 usuários sem `profiles` (aliases fiscais
  // — database.md §5); um farmer cujos clientes ativos caiam todos nesse grupo produz zero
  // com todos os universos globais "não-vazios". Contar `n > 0` no universo não pega isso;
  // contar a INTERSEÇÃO com a carteira pega.
  'clientes_com_profile',
] as const;

/**
 * Idem para o motor de bundles — que, ao contrário do cross-sell, parte EXCLUSIVAMENTE das
 * regras de associação.
 */
export const INSUMOS_OBRIGATORIOS_BUNDLE = [
  'scores',
  'catalogo',
  'vendaveis',
  'pedidos',
  'carteira_ativa',
  'clientes_com_profile',
  // `regras` É obrigatório aqui, ao contrário do cross-sell: todo bundle nasce de
  // `applicableRules`, que sai de `discoveredRules`. Sem regra descoberta o motor produz
  // zero por CONSTRUÇÃO, não por não haver o que ofertar — e rotular esse zero de
  // `completo` daria à fase 2 licença para expirar a carteira de bundles justamente
  // quando o histórico ficou insuficiente. O próprio `useBundleEngine` já trata o caso
  // assim ("zero regra descoberta quase sempre é dado faltando a montante, não 'a base
  // não tem padrão'") e preserva as regras anteriores; era a completude que discordava
  // dele.
  //
  // Não é hipótese: medido em 18/08/2026, 12 das 24 regras vivas tinham support 1,04%
  // contra o piso de 1,00% — 5 cestas de 479 — e morrem assim que as cestas passarem
  // de 499.
  'regras',
  // A cesta UTILIZÁVEL, que não é o pedido. `pedidos` conta clientes com pedido; o motor
  // consome `baskets`, e só entra em basket o pedido cujos items mapeiam para o catálogo
  // (`items` vazio, malformado ou com `omie_codigo_produto` desconhecido é descartado em
  // silêncio no laço). Uma base cujos pedidos não mapeiam deixa `pedidos`, `carteira_ativa` e
  // `catalogo` fartos, gera zero regra — e sem este insumo o head sairia `completo`.
  'baskets',
] as const;

/**
 * Avalia a completude de um snapshot.
 *
 * Duas formas de degradar, e elas são diferentes:
 *  1. **Não consegui ler** (`ok: false`) — falha de transporte. Sempre degrada, para
 *     QUALQUER insumo, obrigatório ou não: um universo lido pela metade produz um
 *     resultado que parece completo e não é (money-path §6).
 *  2. **Li e veio vazio** (`n === 0`) — só degrada nos obrigatórios. É a diferença
 *     entre "a base não tem esse padrão" (legítimo) e "esse insumo não existe" (falta).
 *
 * @param insumos          o que o motor leu, por nome
 * @param obrigatoriosNaoVazios quais insumos não podem vir vazios
 */
export function avaliarCompletude(
  insumos: InsumosSnapshot,
  obrigatoriosNaoVazios: readonly string[],
): VeredictoCompletude {
  // Ordem estável (não a de inserção do objeto): com dois insumos quebrados, o motivo
  // gravado precisa ser o mesmo em toda execução, senão duas falhas idênticas viram
  // duas linhas de head diferentes e a agregação por motivo mente.
  const nomes = Object.keys(insumos).sort();

  const falharam = nomes.filter((nome) => !insumos[nome].ok);
  if (falharam.length > 0) {
    return {
      completude: 'degradado',
      motivo: `não consegui ler: ${falharam.join(', ')}`,
    };
  }

  // `ausentes` ≠ `vaziosDeVerdade`: um obrigatório que o motor NEM TENTOU ler não pode
  // ser tratado como "li e veio vazio" — é o §2 (ausente ≠ zero) na própria medição.
  const ausentes = obrigatoriosNaoVazios.filter((nome) => !(nome in insumos));
  if (ausentes.length > 0) {
    return {
      completude: 'degradado',
      motivo: `insumo obrigatório não declarado: ${[...ausentes].sort().join(', ')}`,
    };
  }

  const vazios = obrigatoriosNaoVazios.filter((nome) => insumos[nome].n === 0);
  if (vazios.length > 0) {
    return {
      completude: 'degradado',
      motivo: `insumo obrigatório veio vazio: ${[...vazios].sort().join(', ')}`,
    };
  }

  // COBERTURA por último: só chega aqui quem leu tudo, declarou tudo e não veio vazio. O que
  // resta é o buraco que nenhum contador global mostra — a parte do universo que o motor
  // efetivamente ALCANÇOU.
  const semCobertura = nomes.filter((nome) => {
    const i = insumos[nome];
    if (i.esperado == null || i.pisoCobertura == null) return false;
    // Universo vazio não é cobertura ruim: 0 de 0 é 100% do que havia. Quem julga o universo
    // vazio é a regra dos obrigatórios acima — aqui isso seria contar a mesma falta duas vezes,
    // com o motivo apontando o sintoma em vez da causa.
    if (i.esperado <= 0) return false;
    return i.n < i.esperado * i.pisoCobertura;
  });
  if (semCobertura.length > 0) {
    return {
      completude: 'degradado',
      motivo: `cobertura insuficiente: ${[...semCobertura].sort().join(', ')}`,
    };
  }

  return { completude: 'completo', motivo: null };
}
