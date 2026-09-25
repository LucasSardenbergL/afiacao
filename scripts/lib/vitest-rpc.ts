/**
 * vitest-rpc.ts — o rc != 0 que NAO veio de teste falhando.
 * ========================================================
 *
 * Sob contencao (M2 8GB com ~12 sessoes), o `vitest run` sai **1** com o resumo inteiro impresso,
 * ZERO teste falhando, e um unico erro: `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` —
 * o RPC birpc do worker estourando por inanicao da thread principal. Medido: 8 rodadas do MESMO
 * comando, com a MESMA captura, deram rc=0 duas vezes e rc=1 seis vezes (#2530). Para o motor de
 * exclusividade, contar isso como "o gate pegou o defeito" fabrica co-deteccao — e co-deteccao
 * fabricada vira `EXCLUSIVIDADE_ZERO`, que e o argumento para APAGAR um detector real.
 *
 * ## O que este modulo NAO faz (a licao que ele quase atropela)
 *
 * `docs/historico/a-forma-que-some-e-a-forma-que-mente.md` registrou, sobre a MESMA string de erro:
 * "o veredito e o exit code, nao o texto bonito acima dele". Esta classificacao **nao** promove o
 * texto a veredito: `classificarVermelho` nunca devolve "verde". Ela devolve, no maximo,
 * `RPC-SEM-DADO` — *ausencia de dado*, a mesma familia do `estourou` do motor. Quem decide o que
 * fazer com isso e o chamador, e a politica dele esta declarada no cabecalho do motor.
 *
 * Reconciliacao honesta, porque a meia-verdade aqui seria cara: o texto NAO vira veredito, mas ele
 * decide QUAL OBSERVACAO VALE. Isso e politica de repeticao, e por isso ela tem orcamento (1),
 * dono unico (o motor) e termino explicito — nunca "repetir ate dar verde".
 *
 * ## Onde a assinatura NAO distingue (limite declarado)
 *
 * Um defeito que segure o event loop produz a MESMA assinatura de uma maquina saturada — foi o
 * incidente dos 79s do doc acima. Logo a assinatura sozinha nao separa "contencao externa" de
 * "regressao de custo causada pelo defeito". Por isso o motor so aceita a repeticao como VERDE no
 * BASELINE (onde nao ha defeito, e a hipotese e vazia); sob defeito, suspeito vira linha INVALIDA.
 */

/** Piso ANTI-TRUNCAMENTO. Pega "rodou 3 arquivos", nao "rodou 400 de 842" — este e o eixo fraco. */
export const PISO_ARQUIVOS = 400;
export const PISO_TESTES = 4_000;

/** A linha do erro, ancorada na COLUNA 0: o mesmo texto dentro de um code-frame vem indentado. */
const LINHA_RPC = /^Error: \[vitest-(?:worker|pool)\]: Timeout calling "/gm;
const LINHA_ERROS = /^\s*Errors\s+(\d+)\s+errors?\s*$/gm;

/** Nao exportada de proposito: so aparece DENTRO de `ResumoVitest` (o `knip` cobra o resto). */
interface ContagemVitest {
  total: number;
  falharam: number;
}

export interface ResumoVitest {
  arquivos: ContagemVitest;
  testes: ContagemVitest;
}

/**
 * Le ` Test Files  1 failed | 1 passed (2)` / `      Tests  1 failed | 2 passed | 1 skipped (5)`.
 * Devolve `null` se QUALQUER das duas linhas faltar — suite morta antes do fim (o
 * `fork: Resource temporarily unavailable` com 1307/1333 processos) nao imprime resumo, e sem
 * resumo nao ha o que afirmar. Formato conferido contra o vitest 3.2.6 real, nao contra o bundle.
 */
export function lerResumoVitest(saida: string): ResumoVitest | null {
  const arquivos = lerContagem(saida, 'Test Files');
  const testes = lerContagem(saida, 'Tests');
  return arquivos && testes ? { arquivos, testes } : null;
}

function lerContagem(saida: string, rotulo: string): ContagemVitest | null {
  // A ULTIMA ocorrencia: um gate composto pode ter varias suites na mesma captura.
  const re = new RegExp(String.raw`^\s*${rotulo}\s+(.*?)\s*\((\d+)\)\s*$`, 'gm');
  const todas = [...saida.matchAll(re)];
  const m = todas.at(-1);
  if (!m) return null;

  let falharam = 0;
  for (const pedaco of m[1].split('|')) {
    const p = /^\s*(\d+)\s+([a-z]+)\s*$/.exec(pedaco);
    if (!p) return null; // formato que nao reconheco nao vira contagem otimista
    if (p[2] === 'failed') falharam += Number(p[1]);
  }
  return { total: Number(m[2]), falharam };
}

/** Idem: o consumidor compara `.classe` com o literal, nunca nomeia o tipo. */
type ClasseDoVermelho = 'REPROVA' | 'RPC-SEM-DADO';

export interface Classificacao {
  classe: ClasseDoVermelho;
  /** Por que — entra no log do motor. Em REPROVA diz qual condicao NAO bateu. */
  motivo: string;
}

/**
 * Classifica um rc != 0 ja observado. **Fail-closed por construcao**: tudo que nao bate TODAS as
 * condicoes e `REPROVA`, inclusive saida ilegivel, vazia ou de outro runner.
 *
 * Recebe os canais INTEIROS, nunca a `cauda` truncada do motor: um segundo erro real que caisse
 * fora dos ultimos 600 bytes viraria "so o RPC" e o vermelho legitimo sumiria.
 */
export function classificarVermelho(
  stdout: string,
  stderr: string,
  piso: { arquivos: number; testes: number } = { arquivos: PISO_ARQUIVOS, testes: PISO_TESTES },
): Classificacao {
  const tudo = `${stdout}\n${stderr}`;

  const resumo = lerResumoVitest(stdout);
  if (!resumo) return { classe: 'REPROVA', motivo: 'sem linha de resumo do vitest (ausencia de dado NAO e verde)' };

  if (resumo.arquivos.falharam > 0 || resumo.testes.falharam > 0) {
    return {
      classe: 'REPROVA',
      motivo: `${resumo.testes.falharam} teste(s) e ${resumo.arquivos.falharam} arquivo(s) falhando`,
    };
  }

  if (resumo.arquivos.total < piso.arquivos || resumo.testes.total < piso.testes) {
    return {
      classe: 'REPROVA',
      motivo: `denominador aquem do piso (${resumo.arquivos.total}/${resumo.testes.total} < ${piso.arquivos}/${piso.testes}) — suite truncada nao e suite verde`,
    };
  }

  // O fecho: os erros DECLARADOS pelo vitest tem de ser, todos, o RPC. Exigir >= 1 impede que um
  // gate composto SEM linha `Errors` (shell que falhou por conta propria depois de uma suite verde)
  // case por vacuidade — `0 === 0` aprovaria o vermelho legitimo dele.
  const declarados = [...tudo.matchAll(LINHA_ERROS)].reduce((s, m) => s + Number(m[1]), 0);
  const rpc = [...tudo.matchAll(LINHA_RPC)].length;
  if (rpc === 0) return { classe: 'REPROVA', motivo: 'nenhum `[vitest-worker]: Timeout calling` na saida' };
  if (declarados !== rpc) {
    return { classe: 'REPROVA', motivo: `o vitest declarou ${declarados} erro(s) e so ${rpc} e(sao) o RPC — sobra erro real` };
  }

  return {
    classe: 'RPC-SEM-DADO',
    motivo: `rc != 0 com ${resumo.arquivos.total} arquivo(s) / ${resumo.testes.total} teste(s) passando e ${rpc} RPC estourado(s)`,
  };
}
