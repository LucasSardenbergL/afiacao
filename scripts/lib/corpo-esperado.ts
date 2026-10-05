/**
 * corpo-esperado.ts — "existe" ≠ "está na versão que a edge espera" (lógica pura).
 *
 * ## O incidente que criou este arquivo (#2428, medido 2026-09-09)
 *
 * `pendencias:pacote` declarou **"✅ pré-condição de banco satisfeita"** para uma leva de 5 edges
 * e liberou a colagem. A RPC `public.criar_pedidos_com_itens` estava lá — na versão ANTERIOR à
 * migration `20260908215704_desconto_valor_atravessa_os_escritores.sql`, mergeada e não aplicada.
 * A edge da main apura `descontoItemOmie` e o manda no payload; a RPC velha recebe o `jsonb` e
 * **descarta o campo sem erro**. `order_items.desconto_valor` seguiria NULL (71.006/71.006), o
 * sync reportaria sucesso, e o ledger passaria a atestar CONFERE — money-path, falha SILENCIOSA.
 *
 * O `precondicao-banco.ts` já previa este dia. O cabeçalho dele declarava o limite e o **gatilho
 * de reentrada**: *"o primeiro incidente em que a RPC EXISTIA e mesmo assim a edge quebrou por
 * contrato"*. Este é o incidente — e ele é pior do que o previsto: não houve erro nenhum.
 *
 * ## Por que o conserto ÓBVIO é o errado
 *
 * "Compare o corpo em prod com o corpo do repo e reprove a divergência" TRAVA TODO DEPLOY.
 * Apply manual diverge do repo por DESENHO (`docs/agent/database.md` §4: a última a recriar vence,
 * ~210 objetos em prod sem `CREATE` commitado, 108 funções que o `audit:migrations` já classifica
 * como DERIVA). Medido nas 65 RPCs literais das 97 edges deste repo: **14 divergem do repo**, e
 * **11 dessas divergências são benignas** — edição direta no SQL Editor, o modo normal de operar
 * este banco. Um gate que reprovasse divergência bloquearia 17/65 e seria desligado na 1ª semana,
 * exatamente como o `precondicao-banco.ts` argumenta: *"gate de deploy que bloqueia sem razão não
 * é conservador: ele ensina o operador a contorná-lo, e aí não gateia mais nada."*
 *
 * ## O discriminador: bater com uma versão ANTERIOR **do próprio repo** é evidência POSITIVA
 *
 * A pergunta certa não é "o corpo bate com o repo?" e sim **"a migration desta leva foi
 * aplicada?"**. Ela tem resposta positiva e barata, e é a mesma taxonomia que a Seção 3 do
 * `audit-custom-migrations.ts` já usa desde 2026-08-29 — só que lá ela vive num SQL que alguém
 * precisa COLAR, que é a mesma prosa executável do #2285:
 *
 *   ✅ `EM_DIA`         o corpo vivo é o da ÚLTIMA migration que define a função.
 *   ❌ `CORPO_ANTERIOR` o corpo vivo é o de uma migration **ANTERIOR do próprio repo**. Prod roda
 *                       uma versão que este repo commitou ANTES da atual ⇒ o efeito da posterior
 *                       não está no ar. É o único estado que BLOQUEIA.
 *   🔴 `DERIVA`         o corpo vivo não bate com NENHUMA versão commitada ⇒ edição manual. NÃO é
 *                       "falta colar", e tratá-la como tal fabricaria os 11 alarmes acima.
 *   ⚪ `INDECIDIVEL`    não há corpo commitado, prod tem overload, ou prod não expõe corpo textual
 *                       (`LANGUAGE c`; `LANGUAGE sql` com `prosqlbody`, cujo `prosrc` é VAZIO).
 *
 * ## O re-teste por TOKENS do que o md5 exato chama de `DERIVA` (2026-09-26)
 *
 * Medido em prod (`docs/historico/deriva-so-de-comentario-no-corpo.md`): 31 funções rodam o corpo
 * commitado MENOS as linhas de comentário — uniforme por migration, concentrado nos applies de
 * mai–jul/2026 — e o relatório chamava de "edição manual" a mesma lógica. `classificarComTokens`
 * re-testa o que sai `DERIVA` com o critério ÚNICO de "mesmo programa" deste repo, `mesmosTokens`
 * (`tokens-sql.ts`, o scanner do #2576, que segue o `scan.l`): comentário e espaço fora, literal e
 * dollar-quote opacos, byte a byte. Segundo léxico para isto NÃO: o da 1ª versão (linhas inteiras de
 * `--`) tinha três P1 reproduzidos pelo Codex, e este scanner responde DIFERENTES nos três.
 *
 *   🔵 `VARIANTE_COSMETICA` o corpo vivo tem os MESMOS tokens da ÚLTIMA versão. Lógica idêntica; não
 *                       bloqueia, e vai para uma lista PRÓPRIA do veredito (não é "fora do alcance").
 *   ❌ `CORPO_ANTERIOR` também por tokens: os mesmos tokens de uma versão ANTERIOR é a lógica velha
 *                       em prod, comentário à parte — BLOQUEIA. Até aqui caía em `DERIVA` e liberava
 *                       (P1 latente apontado pelo Codex; 0 casos medidos).
 *   ⚪ `SEM_TEXTO`      o exato deu `DERIVA` e o texto de prod para o re-teste não veio (ou não
 *                       reproduz o md5 medido). Sem ele, "edição manual" e "corpo anterior sem
 *                       comentário" são indistinguíveis — o gate diz que não mediu (`INCERTA`).
 *   ⚪ `MODO_DIVERGENTE` o veredito por tokens com standard_conforming_strings=on difere do veredito com
 *                       `off` (um literal simples com barra muda de fronteira). O modo de execução da RPC
 *                       não é observável daqui por inteiro (o `proconfig` é; o default do papel que chama,
 *                       não) ⇒ `INCERTA`, nunca o veredito de um modo só — exigir os dois só para
 *                       "cosmético" tirava o BLOQUEIO do anterior que casa em `on` (Codex, confirmação).
 *
 * A ORDEM é o que mantém o gate honesto: as checagens EXATAS vêm antes e não mudam (`classificarCorpo`
 * está intocado; o re-teste só vê o que ele devolveu como `DERIVA`). Dentro do re-teste, a ÚLTIMA
 * versão primeiro — o mesmo desempate do exato.
 *
 * ⚠️ EXCEÇÃO CONSERVADORA, deliberada: se a última migration só ACRESCENTOU comentário, prod pode
 * bater EXATAMENTE com a anterior — e a precedência exata diz `CORPO_ANTERIOR`, mesmo com os tokens
 * iguais aos da última. Fica assim porque não mexer nas checagens exatas é o requisito, e um falso
 * bloqueio aqui custa uma conferência; afrouxá-lo seria julgar tokens ANTES do exato (o teste
 * reprova). Caso real: `kb_documents_set_updated_at` (as duas versões têm os mesmos 14 tokens).
 *
 * Medido nas mesmas 65 RPCs: **48 EM_DIA · 3 CORPO_ANTERIOR · 11 DERIVA · 2 INDECIDIVEL · 1 ausente**.
 * As 3 `CORPO_ANTERIOR` são exatamente as 3 funções da migration pendente. Zero falso positivo.
 *
 * O rótulo diz `CORPO_ANTERIOR`, e não "migration não aplicada", de propósito (achado do Codex): o
 * catálogo do Postgres não guarda histórico de apply. "Prod está rodando um corpo que este repo
 * commitou antes do atual" é o que se MEDE; "a migration não foi aplicada" é a explicação mais
 * provável, mas uma migration aplicada e depois sobrescrita por uma antiga daria a mesma leitura.
 * A AÇÃO é a mesma nos dois casos — aplicar a DDL da leva — e é ela que o relatório manda fazer.
 *
 * ## O que este eixo NÃO cobre (declarado, não deduzido)
 *
 * `DERIVA` **não bloqueia**, e isso é fail-open DELIBERADO: uma função editada à mão que também
 * ignore o campo novo produz a MESMA falha silenciosa e passa por aqui. O eixo não tem como
 * distingui-la de uma edição manual legítima sem um `CREATE` commitado para comparar, e a troca é
 * a de sempre — precisão > recall, porque o bloqueio falso mata o gate inteiro. O que fecha esse
 * resto é commitar a DDL (aí a função sai de `DERIVA`), não este arquivo.
 *
 * Também não vê: `ALTER FUNCTION`, mudança só de atributo (`SECURITY DEFINER`, `search_path`),
 * `DROP`+`CREATE` com corpo idêntico, nem COLUNA — o gate de coluna continua ausente, como o
 * `precondicao-banco.ts` já declarava.
 */
import { extractObjects, md5Exato } from './migration-objects';
import { md5DeTokens, mesmosTokensNoModo } from './tokens-sql';

export { md5Exato };

/** Uma versão do corpo de uma função, como alguma migration a commitou. */
export interface VersaoDeCorpo {
  /** Nome do arquivo da migration. */
  migration: string;
  /**
   * md5 do corpo EXATO — o que `md5(pg_proc.prosrc)` devolve. A receita ESTRITA, não a
   * normalizada do audit: ver `bodyMd5Exato` em `migration-objects.ts`.
   */
  md5: string;
  /**
   * O corpo CRU que deu o `md5` (`bodyExato`, da MESMA delimitação). Obrigatório: é o texto do
   * re-teste por tokens, e uma versão sem ele deixaria o `CORPO_ANTERIOR` por tokens cego em silêncio.
   */
  corpo: string;
}

/** Uma migration lida da árvore: nome do arquivo e o SQL CRU (comentários inclusive). */
export interface MigrationLida {
  nome: string;
  sql: string;
}

type Classificacao =
  | 'EM_DIA'
  | 'CORPO_ANTERIOR'
  | 'VARIANTE_COSMETICA'
  | 'DERIVA'
  | 'INDECIDIVEL'
  | 'SEM_TEXTO'
  | 'MODO_DIVERGENTE';

/** A evidência de um casamento por TOKENS — para o relatório ser conferível sem reexecutar nada. */
export interface ProvaPorTokens {
  /** md5 EXATO do `prosrc` de prod (calculado no banco; o texto o reproduziu). */
  md5Prod: string;
  /** md5 EXATO do corpo commitado na versão casada — difere de `md5Prod`, senão o exato teria casado. */
  md5Repo: string;
  /** md5 da sequência de tokens (`md5DeTokens`) — o MESMO dos dois lados, por construção. */
  md5Tokens: string;
}

export interface VereditoDeCorpo {
  classificacao: Classificacao;
  /** Presente quando o casamento (`VARIANTE_COSMETICA` ou `CORPO_ANTERIOR`) foi por tokens, não byte a byte. */
  tokens?: ProvaPorTokens;
  /** A migration que define o corpo esperado — a ÚLTIMA que recria a função. */
  esperada?: string;
  /** Em `CORPO_ANTERIOR`: a migration cujo corpo prod está rodando. */
  emProd?: string;
  /** Quantas versões do corpo o repo commitou para esta função. */
  versoes: number;
  /** Por que é `INDECIDIVEL`, quando é. */
  motivo?: string;
}

/** O corpo VIVO de uma função em prod, como a sonda o mediu. */
export interface CorpoVivo {
  /** md5 exato de cada corpo textual encontrado. Vazio = prod não tem corpo comparável. */
  md5s: readonly string[];
  /** Quantas entradas de `pg_proc` têm este nome — >1 é overload. */
  overloads: number;
}

/**
 * Histórico ORDENADO do corpo de cada função, por `schema.nome`, ao longo das migrations dadas.
 *
 * A ordem de entrada É a ordem de apply — quem chama ordena (lexical do nome do arquivo, que
 * carrega o timestamp na frente). Ordenar aqui dentro esconderia de quem chama a decisão de
 * QUAIS migrations entram, que é a metade que importa: o `audit:migrations` inclui as de nome
 * UUID de propósito (sem elas, 11 funções saem da checagem — medido em 2026-08-29), e o gate de
 * deploy precisa da mesma cobertura.
 *
 * Funções sem `bodyMd5` (corpo não extraível — sem dollar-quote, `LANGUAGE c`) ficam FORA do
 * histórico: ausência de corpo esperado vira `INDECIDIVEL` no julgamento, nunca `EM_DIA`.
 */
export function historicoDeCorpos(migrations: readonly MigrationLida[]): Map<string, VersaoDeCorpo[]> {
  const hist = new Map<string, VersaoDeCorpo[]>();
  for (const { nome, sql } of migrations) {
    for (const o of extractObjects(sql)) {
      if (o.kind !== 'function' || o.bodyMd5Exato === undefined || o.bodyExato === undefined) continue;
      const chave = `${o.schema}.${o.name}`.toLowerCase();
      const l = hist.get(chave) ?? [];
      l.push({ migration: nome, md5: o.bodyMd5Exato, corpo: o.bodyExato });
      hist.set(chave, l);
    }
  }
  return hist;
}

/**
 * O julgamento de UMA função: o histórico commitado × o corpo VIVO em prod.
 *
 * 🔴 **A ÚLTIMA versão é conferida PRIMEIRO.** Uma migration nova pode repetir exatamente um corpo
 * anterior (rollback commitado, `CREATE OR REPLACE` idêntico) — e aí o md5 casa nas duas pontas.
 * Perguntar "bate com a última?" antes de "bate com alguma anterior?" faz esse empate cair em
 * `EM_DIA`, que é o certo: a igualdade não distingue qual das duas rodou, e bloquear por ordem de
 * varredura seria bloqueio inventado (achado do Codex).
 *
 * 🔴 **Overload em prod é `INDECIDIVEL`, não "bate com algum".** O extrator de migration colapsa
 * overload no último corpo do arquivo, então "algum bate" pode ser o overload ERRADO — e para o
 * PostgREST a identidade de chamada inclui nomes e defaults dos argumentos, que este eixo não lê.
 * São 16 nomes com mais de uma assinatura em `public` (zero entre os alvos de hoje); o dia em que
 * um deles entrar numa leva, o gate diz "não sei" em vez de inventar. `overloads` é MEDIDO a cada
 * execução, e não uma suposição congelada nesta linha.
 *
 * 🔴 **Lista de corpos VAZIA não é "em dia"**: é prod sem corpo textual (`LANGUAGE c`, cujo
 * `prosrc` é um símbolo e não o código; `LANGUAGE sql` com `prosqlbody`, cujo `prosrc` é vazio) ou
 * a sonda não ter trazido a linha. Nos dois casos, `INDECIDIVEL` — nunca verde.
 *
 * Interna desde 2026-10-01 (o corpo não mudou): o gate chama `classificarComTokens`, que delega a
 * ela — exportá-la sem consumidor externo reprova no gate de dead-code (`knip`), que só roda no CI.
 */
function classificarCorpo(
  versoes: readonly VersaoDeCorpo[] | undefined,
  vivo: CorpoVivo,
): VereditoDeCorpo {
  const n = versoes?.length ?? 0;
  if (versoes === undefined || n === 0) {
    return { classificacao: 'INDECIDIVEL', versoes: 0, motivo: 'nenhuma migration commita o corpo desta função' };
  }
  const ultima = versoes[n - 1];
  const base = { esperada: ultima.migration, versoes: n };
  if (vivo.overloads > 1) {
    return {
      ...base,
      classificacao: 'INDECIDIVEL',
      motivo: `${vivo.overloads} assinaturas com este nome em prod — o corpo esperado não distingue overload`,
    };
  }
  if (vivo.md5s.length === 0) {
    return {
      ...base,
      classificacao: 'INDECIDIVEL',
      motivo: 'prod não expôs corpo textual comparável (LANGUAGE c, prosqlbody, ou linha ausente)',
    };
  }
  const vivos = new Set(vivo.md5s);
  // A última PRIMEIRO — ver o cabeçalho: empate com uma anterior tem de cair em EM_DIA.
  if (vivos.has(ultima.md5)) return { ...base, classificacao: 'EM_DIA' };
  // Bate com uma ANTERIOR: a mais RECENTE das anteriores que casa é a que prod está rodando.
  for (let i = n - 2; i >= 0; i--) {
    if (vivos.has(versoes[i].md5)) {
      return { ...base, classificacao: 'CORPO_ANTERIOR', emProd: versoes[i].migration };
    }
  }
  return { ...base, classificacao: 'DERIVA' };
}

/**
 * O julgamento COMPLETO do eixo 5: o exato (`classificarCorpo`, intocado) e, SÓ no que ele chamou de
 * `DERIVA`, o re-teste por tokens contra as versões commitadas (ver o cabeçalho).
 *
 * `textos` são os `prosrc` de prod que a sonda de detalhe trouxe para esta função. Só vale o que
 * REPRODUZ um md5 que o exato julgou (`vivo.md5s`): texto de outro corpo, comparado por tokens,
 * fabricaria veredito sobre o corpo errado. Nenhum assim ⇒ `SEM_TEXTO`, nunca "edição manual".
 */
export function classificarComTokens(
  versoes: readonly VersaoDeCorpo[] | undefined,
  vivo: CorpoVivo,
  textos: readonly string[],
): VereditoDeCorpo {
  const exato = classificarCorpo(versoes, vivo);
  // 🔴 A precedência EXATA, numa linha só: o que o md5 decidiu não é reaberto por tokens.
  if (exato.classificacao !== 'DERIVA' || versoes === undefined) return exato;
  const texto = textos.find((t) => vivo.md5s.includes(md5Exato(t)));
  if (texto === undefined) {
    return { ...exato, classificacao: 'SEM_TEXTO', motivo: 'o texto de prod não veio, ou não reproduz o md5 medido' };
  }
  const prova = (v: VersaoDeCorpo): ProvaPorTokens => ({
    md5Prod: md5Exato(texto),
    md5Repo: v.md5,
    md5Tokens: md5DeTokens(texto),
  });
  const n = versoes.length;
  // O casamento em CADA modo de standard_conforming_strings. A última PRIMEIRO — o desempate do exato:
  // tokens iguais aos da última E aos de uma anterior não dizem qual das duas rodou.
  const casaNoModo = (scsOff: boolean): number => {
    if (mesmosTokensNoModo(texto, versoes[n - 1].corpo, scsOff)) return n - 1;
    for (let i = n - 2; i >= 0; i--) if (mesmosTokensNoModo(texto, versoes[i].corpo, scsOff)) return i;
    return -1;
  };
  const on = casaNoModo(false);
  const off = casaNoModo(true);
  const descrever = (k: number): string =>
    k < 0 ? 'não casa versão nenhuma' : `casa ${k === n - 1 ? 'a última' : 'a anterior'} \`${versoes[k].migration}\``;
  // 🔴 Só vale o veredito em que os DOIS modos concordam (ver `MODO_DIVERGENTE` no cabeçalho).
  if (on !== off) {
    return { ...exato, classificacao: 'MODO_DIVERGENTE', motivo: `com scs=on ${descrever(on)}; com scs=off ${descrever(off)}` };
  }
  if (on < 0) return exato;
  if (on === n - 1) return { ...exato, classificacao: 'VARIANTE_COSMETICA', tokens: prova(versoes[on]) };
  return { ...exato, classificacao: 'CORPO_ANTERIOR', emProd: versoes[on].migration, tokens: prova(versoes[on]) };
}

/**
 * As funções que uma migration define — o CONJUNTO ACOPLADO.
 *
 * Por que o gate precisa disto (achado do Codex, e a própria migration do incidente o diz na
 * linha 8): `20260908215704` recria TRÊS escritores de `order_items`, e eles só funcionam juntos —
 * `criar_pedidos_com_itens` apura o desconto, `aplicar_edicao_pedido_omie` o transporta numa
 * edição, `reconciliar_pedidos_omie` o invalida quando a base econômica muda. Mas eles são
 * chamados por edges DIFERENTES: os dois primeiros por `omie-vendas-sync`, o terceiro por
 * `sync-reprocess`. Uma leva com só `omie-vendas-sync` mediria dois dos três, e o dado nasceria
 * para morrer no primeiro reprocessamento.
 *
 * A unidade de APPLY é a migration, não a função: o `BEGIN; … COMMIT;` sobe as três de uma vez.
 * Então, quando uma RPC da leva aponta para uma migration, o gate confere TODAS as funções dessa
 * migration — inclusive as que nenhuma edge da leva chama. É o recorte "da janela do pacote" no
 * nível em que o apply de fato acontece.
 */
export function irmasDaMigration(
  historico: ReadonlyMap<string, readonly VersaoDeCorpo[]>,
  migration: string,
): string[] {
  const fora: string[] = [];
  for (const [chave, versoes] of historico) {
    if (versoes.some((v) => v.migration === migration)) fora.push(chave);
  }
  return fora.sort((a, b) => a.localeCompare(b, 'en'));
}
