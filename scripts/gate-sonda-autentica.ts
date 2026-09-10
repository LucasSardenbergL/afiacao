#!/usr/bin/env bun
/**
 * gate-sonda-autentica.ts — "a resposta de sonda só sai DEPOIS do gate de credencial".
 * ============================================================================================
 *
 * ## A premissa que este gate transforma em invariante
 *
 * O `controle_ativo` do `scripts/sonda-versao-sql.ts` decide se um HTTP 401 vira veredito
 * DETERMINADO. Ele conclui "o `x-cron-secret` deste disparo foi ACEITO" a partir de uma
 * TESTEMUNHA: uma resposta desta leva com `versao` e `fonte` iguais às esperadas. A cadeia
 * fecha em três elos:
 *
 *   1. o `fonte` é o sha256 do arquivo servido ⇒ o bundle no ar é VERBATIM o do repo;
 *   2. **no repo, o gate de credencial roda ANTES de emitir a resposta de sonda** ⇐ ESTE GATE;
 *   3. o `request_id` amarra a resposta a ESTE disparo.
 *
 * Sem (2) o controle é fail-OPEN, e não de um jeito teórico. O parecer Codex (gpt-6-astra,
 * 2026-09-09) derrubou a primeira versão deste controle — que aceitava 2xx CRU como prova — com
 * um contraexemplo do próprio repo: `monthly-report@ef08dddd2` é um bundle histórico que ignora
 * a credencial e manda e-mail para QUALQUER POST (o `sonda-relay/index.ts` documenta esse
 * histórico). Um 200 desse bundle não prova credencial nenhuma. A testemunha por IDENTIDADE
 * fecha o contraexemplo — mas só enquanto (2) valer para o código do repo.
 *
 * E (2) era, até este gate, uma MEDIÇÃO datada (60/60 em 2026-09-09), não uma invariante. Medição
 * não impede a edge instrumentada AMANHÃ de responder à sonda antes de autenticar — e essa
 * regressão não apareceria em lugar nenhum: o SQL seguiria verde, contando como testemunha uma
 * resposta que não testemunha nada. É a classe "fase N+1 exige sinal da fase N" na direção do
 * sensor: quem sustenta uma decisão money-path precisa de vigia próprio.
 *
 * ## A régua
 *
 * Universo: toda pasta de `supabase/functions/` com `versao.ts` E `index.ts` — exatamente o que
 * `resolverLeva()` aceita, e ele é fail-CLOSED (edge sem `versao.ts` aborta o gerador sem emitir
 * SQL). Denominador vazio REPROVA: um universo que sumiu é ausência de dado, não aprovação.
 *
 * Para cada uma, no fonte com comentários E imports removidos: a primeira ocorrência de
 * `authorizeCron*(` tem de vir ANTES da primeira emissão de resposta de sonda. Imports saem
 * porque `import { authorizeCronOrStaff } from …` satisfaria o gate no topo do arquivo sem que
 * ninguém chamasse nada — verde por CEGUEIRA, que é o modo como gate textual costuma morrer.
 *
 * ⚠️ COMENTÁRIO SAI PELO STRIPPER COMPARTILHADO (`removerComentarios`), nunca por regex local:
 * regex que não sabe o que é string apaga o miolo do arquivo antes da medição. E o alarme do
 * stripper tem DOIS lados, os dois vigiados aqui:
 *   · SOBRE-limpeza — `maiorBlocoDescartado` acima do teto significa que a limpeza comeu código,
 *     e a medição seguinte não vale;
 *   · SUB-limpeza — arquivo que TEM comentário e sai da limpeza do mesmo tamanho significa que o
 *     stripper não rodou; sem este lado, um stripper quebrado devolveria tudo e o gate mediria o
 *     texto cru, onde o import volta a satisfazer a regra.
 * O eixo POR FORA é o denominador: a contagem de edges auditadas é conferida contra a contagem de
 * `versao.ts` no disco, que não passa pelo stripper. Sensor que só consulta a máquina que vigia
 * herda o defeito dela.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { maiorBlocoDescartado, removerComentarios } from '@/lib/gates/limpeza-fonte';

/** Onde as edges moram, a partir da raiz do repo. */
export const DIR_FUNCTIONS = 'supabase/functions';

/**
 * Emissão da RESPOSTA de sonda — não o classificador.
 *
 * `classificarSonda(corpo)` decide se o corpo pede sonda e é chamado ANTES do gate no padrão
 * dominante do repo (o gate mora dentro do `if`), então medi-lo daria 6 falsos positivos. O que
 * importa é onde a resposta é EMITIDA: é ela que só pode sair autenticada.
 */
const EMISSAO = /(criarRespostaSonda|respostaSonda\w*)\s*\(/;

/** O gate que valida o `x-cron-secret` — a credencial que o disparo do gerador manda. */
const GATE = /authorizeCron\w*\s*\(/;

/**
 * A via `OPTIONS`, que sai da medição — e por que sair dela é PRECISÃO, não indulgência.
 *
 * `atenderSondaOptions` recebe a `respostaSonda` como CALLBACK, então o texto dela aparece antes
 * do `authorizeCron*` em 16 edges. Mas ali a resposta não é emitida sem autenticar: o helper
 * confere um HMAC (`verificarCredencial`) antes de devolver `Response`, e só atende `OPTIONS` —
 * método que o pg_net 0.19.5 NÃO emite (é a razão de o `sonda-relay` existir). Logo essa resposta
 * é inalcançável pelo disparo do gerador e nunca vira testemunha do `controle_ativo`.
 *
 * ⚠️ Some só a CHAMADA, nunca o arquivo inteiro: aceitar `atenderSondaOptions` como se fosse o
 * gate do POST seria o furo — uma edge que o chamasse no topo e depois respondesse ao POST sem
 * `authorizeCron*` passaria batido. Removendo a chamada, a emissão do POST continua medida.
 */
const VIA_OPTIONS = /^.*\batenderSondaOptions\s*\(.*$/gm;

/** Uma chamada de `atenderSondaOptions` que NÃO fecha na própria linha (hoje: nenhuma). */
const OPTIONS_MULTILINHA = /\batenderSondaOptions\s*\((?![^\n]*\))/;

/**
 * Teto do maior bloco contíguo que a limpeza pode descartar antes de a medição perder o valor.
 * Calibrado como o do `limpeza-fonte`: o maior cabeçalho legítimo medido no repo tem 88 linhas, e
 * as edges deste universo carregam docblocks longos. 150 fica acima do legítimo e muito abaixo de
 * um estrago de stripper (o caso Sayerlack comeu 924).
 */
export const TETO_BLOCO_DESCARTADO = 150;

export interface AchadoEdge {
  readonly edge: string;
  /** Índice do gate no fonte limpo, ou `null` se não há gate de cron. */
  readonly gate: number | null;
  /** Índice da emissão da resposta de sonda, ou `null` se ela não é emitida aqui. */
  readonly emissao: number | null;
  /** Maior bloco contíguo que a limpeza descartou (alarme de SOBRE-limpeza). */
  readonly blocoDescartado: number;
  /** A limpeza encurtou o fonte? `false` num arquivo com comentário é SUB-limpeza. */
  readonly limpou: boolean;
  /** O arquivo tem comentário a remover? (sem isto, `limpou:false` seria falso alarme) */
  readonly temComentario: boolean;
  /** Uma chamada `atenderSondaOptions` que não fecha na linha — a remoção dela não seria confiável. */
  readonly optionsMultilinha: boolean;
}

/**
 * Remove declarações `import` do fonte JÁ limpo de comentários.
 *
 * Só declarações: um `import()` dinâmico é CÓDIGO e continua contando. O `[\s\S]*?` cobre o
 * import multi-linha, que é a forma dominante neste repo (`import {\n  a,\n  b,\n} from "..."`).
 */
export function removerImports(fonte: string): string {
  return fonte.replace(/^[ \t]*import\s+[\s\S]*?\bfrom\s+["'][^"']+["'];?[ \t]*$/gm, '');
}

/** Audita UM fonte de edge, sem tocar o disco — é por aqui que o teste falsifica. */
export function auditarFonte(edge: string, fonteCru: string): AchadoEdge {
  const limpo = removerComentarios(fonteCru);
  const semImports = removerImports(limpo);
  const medido = semImports.replace(VIA_OPTIONS, '');
  const gate = medido.search(GATE);
  const emissao = medido.search(EMISSAO);
  return {
    edge,
    gate: gate === -1 ? null : gate,
    emissao: emissao === -1 ? null : emissao,
    blocoDescartado: maiorBlocoDescartado(fonteCru),
    limpou: limpo.length < fonteCru.length,
    temComentario: /\/\/|\/\*/.test(fonteCru),
    optionsMultilinha: OPTIONS_MULTILINHA.test(semImports),
  };
}

/** O veredito de uma edge: `null` = passou; string = o motivo da reprovação. */
export function reprovar(a: AchadoEdge): string | null {
  if (a.blocoDescartado > TETO_BLOCO_DESCARTADO) {
    return `${a.edge}: o stripper descartou um bloco de ${a.blocoDescartado} linhas (teto ${TETO_BLOCO_DESCARTADO}) — a limpeza comeu CÓDIGO e a medição abaixo não valeria`;
  }
  if (a.temComentario && !a.limpou) {
    return `${a.edge}: o arquivo tem comentário e a limpeza não encurtou nada — o stripper NÃO rodou, e sem ele o \`import\` do gate satisfaria a regra sozinho`;
  }
  if (a.optionsMultilinha) {
    return `${a.edge}: chamada de \`atenderSondaOptions\` quebrada em várias linhas — a remoção da via OPTIONS deixaria resto no texto medido, e a medição abaixo não valeria. Traga a chamada para uma linha, ou ensine este gate a casar parênteses`;
  }
  // Edge sem emissão de resposta de sonda não é violação: ela simplesmente não testemunha. O
  // gerador nem a alcança sem `versao.ts`, e este universo já é o das que o têm.
  if (a.emissao === null) return null;
  if (a.gate === null) {
    return `${a.edge}: emite resposta de sonda e NÃO chama authorizeCron* — um 2xx dela não prova credencial, e o controle_ativo o contaria como testemunha`;
  }
  if (a.gate > a.emissao) {
    return `${a.edge}: emite a resposta de sonda ANTES de authorizeCron* (emissão em ${a.emissao}, gate em ${a.gate}) — responde sem autenticar`;
  }
  return null;
}

/** Lê o universo do disco: pastas com `versao.ts` E `index.ts`. */
export function universo(raiz: string): string[] {
  const base = join(raiz, DIR_FUNCTIONS);
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter(
      (n) =>
        existsSync(join(base, n, 'versao.ts')) && existsSync(join(base, n, 'index.ts')),
    )
    .sort();
}

export interface Resultado {
  readonly auditadas: number;
  readonly motivos: readonly string[];
}

export function auditar(raiz: string): Resultado {
  const edges = universo(raiz);
  const motivos: string[] = [];
  for (const edge of edges) {
    const fonte = readFileSync(join(raiz, DIR_FUNCTIONS, edge, 'index.ts'), 'utf8');
    const motivo = reprovar(auditarFonte(edge, fonte));
    if (motivo !== null) motivos.push(motivo);
  }
  return { auditadas: edges.length, motivos };
}

if (import.meta.main) {
  const raiz = join(import.meta.dir, '..');
  const { auditadas, motivos } = auditar(raiz);
  // Denominador VAZIO reprova. `for` sobre lista vazia não executa o corpo e sairia 0 — verde por
  // AUSÊNCIA, que é exatamente o modo de falhar que este gate existe para não cometer.
  if (auditadas === 0) {
    console.error(
      '❌ gate-sonda-autentica: NENHUMA edge auditada. O universo (pasta com versao.ts + index.ts) ' +
        'está vazio — isso é ausência de dado, não aprovação. Confira o caminho e repita.',
    );
    process.exit(1);
  }
  if (motivos.length > 0) {
    console.error(`❌ gate-sonda-autentica: ${motivos.length} de ${auditadas} edge(s) reprovam:`);
    for (const m of motivos) console.error(`   · ${m}`);
    console.error(
      '\nA resposta de sonda tem de sair DEPOIS do gate de credencial. O `controle_ativo` do ' +
        '`sonda-versao-sql.ts` trata essa resposta como TESTEMUNHA de que o x-cron-secret foi ' +
        'aceito; emitida antes do gate, ela vira prova de nada e o veredito do 401 sai confiante ' +
        'e errado (redeploy à toa de uma edge que já estava no ar).',
    );
    process.exit(1);
  }
  console.log(`GATE_SONDA_AUTENTICA_OK ${auditadas} edge(s): a sonda só responde autenticada`);
}
