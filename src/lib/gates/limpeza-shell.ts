// Limpeza de FONTE SHELL para gates textuais — a CAMADA que faltava no stripper compartilhado.
//
// `limpeza-fonte.ts` (irmão) entende a gramática do JS/TS: `//`, `/* */`, string, template e regex
// literal. Aplicá-lo a um `.sh` seria pior que regex local — em shell o comentário é `#`, `'…'`
// não tem escape nenhum, `"…"` e `'…'` atravessam quebra de linha de propósito, e o heredoc
// SUSPENDE toda a gramática de aspas até o delimitador. A regra da casa
// (docs/historico/gates-textuais-cegos.md) é escolher a camada do stripper pelo que o gate MEDE;
// para `.sh` não havia camada, então ela nasce aqui em vez de virar regex privada de um gate.
//
// POR QUE HEREDOC É OBRIGATÓRIO, e não refinamento: o repo escreve wrappers-fake por heredoc
//   cat > "$TMPD/psql-ro-fake" <<EOF
//   exec env PSQLRC="$TMPD/psqlrc-fake" "$PGBIN/psql" … "\$@"
//   EOF
// e prosa com apóstrofo solto (`don't`) aparece em heredoc de mensagem. Um scanner que não sabe
// onde o heredoc começa e termina trata esse apóstrofo como abertura de string e DESSINCRONIZA o
// resto do arquivo — que é exatamente a falha Sayerlack (85% do arquivo invisível ao fiscal),
// só que em shell. Aqui o corpo do heredoc sai VERBATIM: dentro dele `#` é dado, não comentário.
//
// CONTRATO: remove comentário de `#` e NADA MAIS. Aspas simples, duplas, `$'…'` ANSI-C, corpo de
// heredoc e continuação de linha (`\` + newline) saem intactos. O número de linhas do resultado é
// igual ao da entrada (mesma razão do irmão: gate que casa `^…` multiline e gate que compara
// POSIÇÃO continuam medindo a mesma coisa).
//
// LIMITE CONHECIDO: aspas em shell atravessam newline por desenho (o repo tem `-c "` com SQL de 8
// linhas), então não dá para usar a quebra de linha como âncora de recuperação como o irmão faz —
// uma aspa desbalanceada de verdade contamina até a próxima aspa igual. É por isso que
// `medirPreservacaoShell` e `maiorBlocoDescartadoShell` existem: são o alarme de fumaça do
// desabamento, e todo gate que consome isto deve travar um piso.

/** `#` só abre comentário quando começa PALAVRA — senão é literal (`${v#pre}`, `a#b`, `%23`). */
const ANTES_DE_COMENTARIO = new Set([' ', '\t', '\n', ';', '|', '&', '(', '`', '\0']);

interface Heredoc {
  delim: string;
  /** `<<-` permite recuo por TAB na linha do delimitador. */
  recuaTab: boolean;
}

/**
 * Contextos empilháveis. `sub` (de `$(…)`) e `crase` voltam ao contexto de COMANDO mesmo estando
 * dentro de aspas duplas — é shell de verdade, e ignorar isso foi o segundo furo medido aqui:
 *   cmd="$(printf '%s' "$input" | sed -n 's|.*"command".*|\1|p')"    ← sed com `|`, ver nota
 * sem a pilha, o primeiro `"` pareia com o `"` de `"$input"`, tudo desanda a partir dali, e o
 * arquivo fica meio invisível ao fiscal. Uma máquina só produz a máscara E a limpeza justamente
 * para que as duas não possam divergir.
 */
type Contexto = 'sq' | 'ansi' | 'dq' | 'sub' | 'crase';

interface Leitura {
  /** Heredocs que a máquina abriu e NUNCA fechou até o fim do arquivo. Ver `heredocsAbertos`. */
  abertosNoFim: number;
  /** 1 = contexto de comando/palavra · 0 = dentro de literal (`'…'`, `"…"`, `$'…'`). */
  mascara: Uint8Array;
  /** Intervalos `[ini, fim)` que são comentário `#` de shell. */
  comentarios: [number, number][];
  /** Intervalos `[ini, fim)` de CORPO de heredoc — ali `#` é dado, não comentário. */
  heredocs: [number, number][];
}

/** Lê o cabeçalho de um heredoc a partir do `<<`. `<<'E'`, `<<"E"`, `<<\E` e `<<-E`. */
function lerCabecalhoHeredoc(s: string, ini: number): { heredoc: Heredoc | null; fim: number } {
  let i = ini + 2;
  let recuaTab = false;
  if (s[i] === '-') { recuaTab = true; i++; }
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;

  if (s[i] === "'" || s[i] === '"') {
    const aspas = s[i];
    const fim = s.indexOf(aspas, i + 1);
    if (fim === -1) return { heredoc: null, fim: i };
    return { heredoc: { delim: s.slice(i + 1, fim), recuaTab }, fim: fim + 1 };
  }

  let j = i;
  let delim = '';
  while (j < s.length && /[A-Za-z0-9_.\-\\]/.test(s[j])) {
    if (s[j] !== '\\') delim += s[j];
    j++;
  }
  if (delim === '') return { heredoc: null, fim: i };
  return { heredoc: { delim, recuaTab }, fim: j };
}

/**
 * A ÚNICA varredura: percorre a fonte uma vez e devolve a máscara de contexto + os intervalos de
 * comentário. `removerComentariosShell` e `mascaraContexto` são projeções disto.
 */
function lerContextoShell(fonte: string): Leitura {
  const n = fonte.length;
  const mascara = new Uint8Array(n);
  const comentarios: [number, number][] = [];
  const heredocs: [number, number][] = [];
  const pilha: Contexto[] = [];
  let iniHeredoc = -1;
  const pendentes: Heredoc[] = [];
  let corpoDeHeredoc: Heredoc | null = null;
  let anterior = '\0';
  let i = 0;

  const topo = () => pilha[pilha.length - 1];
  const literal = () => topo() === 'sq' || topo() === 'dq' || topo() === 'ansi';
  const marcar = (ate: number, valor: number) => { mascara.fill(valor, i, Math.min(ate, n)); };

  while (i < n) {
    // Corpo de heredoc: verbatim, linha a linha, até o delimitador. Ali `#` é dado e aspas não
    // valem — sem isto, um apóstrofo de prosa dessincroniza o resto do arquivo.
    if (corpoDeHeredoc) {
      let fimLinha = fonte.indexOf('\n', i);
      if (fimLinha === -1) fimLinha = n;
      const linha = fonte.slice(i, fimLinha);
      const alvo = corpoDeHeredoc.recuaTab ? linha.replace(/^\t+/, '') : linha;
      marcar(fimLinha + 1, 1);
      if (alvo === corpoDeHeredoc.delim) {
        heredocs.push([iniHeredoc, fimLinha + 1]);
        corpoDeHeredoc = null;
      }
      anterior = '\n';
      i = fimLinha + 1;
      continue;
    }

    const dentro = literal();
    const c = fonte[i];

    if (c === '\n') {
      mascara[i] = dentro ? 0 : 1;
      anterior = '\n';
      i++;
      if (pendentes.length > 0) {
        corpoDeHeredoc = pendentes.shift() ?? null;
        iniHeredoc = i;
      }
      continue;
    }

    if (c === '\\' && topo() !== 'sq') {
      marcar(i + 2, dentro ? 0 : 1);
      anterior = 'x';
      i += 2;
      continue;
    }

    if (topo() === 'sq' || topo() === 'ansi') {
      mascara[i] = 0;
      if (c === "'") pilha.pop();
      anterior = 'x';
      i++;
      continue;
    }

    mascara[i] = dentro ? 0 : 1;

    if (c === '"') {
      if (topo() === 'dq') pilha.pop();
      else pilha.push('dq');
      anterior = 'x';
      i++;
      continue;
    }
    if (c === '$' && fonte[i + 1] === "'" && topo() !== 'dq') {
      marcar(i + 2, 0);
      pilha.push('ansi');
      anterior = 'x';
      i += 2;
      continue;
    }
    if (c === "'" && topo() !== 'dq') {
      pilha.push('sq');
      mascara[i] = 0;
      anterior = 'x';
      i++;
      continue;
    }
    if (c === '$' && fonte[i + 1] === '(') {
      pilha.push('sub');
      marcar(i + 2, 1);
      anterior = '(';
      i += 2;
      continue;
    }
    if (c === '`') {
      if (topo() === 'crase') pilha.pop();
      else pilha.push('crase');
      mascara[i] = 1;
      anterior = '`';
      i++;
      continue;
    }
    if (c === ')' && topo() === 'sub') {
      pilha.pop();
      anterior = ')';
      i++;
      continue;
    }

    if (!dentro) {
      // `<<<` é herestring (lê de uma STRING). Consumir os TRÊS de uma vez é obrigatório: parar
      // no primeiro `<` faz o segundo virar um `<<` sozinho e o delimitador lido vira o argumento
      // (`$REQ_IDS`), que nunca fecha — o resto do arquivo inteiro passa a "corpo de heredoc" e
      // nenhum comentário é limpo dali em diante. Medido em `edges-pendentes.sh:228`.
      if (c === '<' && fonte[i + 1] === '<' && fonte[i + 2] === '<') {
        marcar(i + 3, 1);
        anterior = 'x';
        i += 3;
        continue;
      }
      if (c === '<' && fonte[i + 1] === '<') {
        const { heredoc, fim } = lerCabecalhoHeredoc(fonte, i);
        marcar(fim, 1);
        i = fim;
        anterior = 'x';
        if (heredoc) pendentes.push(heredoc);
        continue;
      }
      if (c === '#' && ANTES_DE_COMENTARIO.has(anterior)) {
        let fimLinha = fonte.indexOf('\n', i);
        if (fimLinha === -1) fimLinha = n;
        comentarios.push([i, fimLinha]);
        marcar(fimLinha, 1);
        i = fimLinha; // o `\n` sai na volta seguinte, preservando a contagem de linhas
        continue;
      }
    }

    anterior = c;
    i++;
  }

  // Heredoc sem delimitador de fechamento (arquivo truncado) ainda é corpo até o fim.
  if (corpoDeHeredoc && iniHeredoc >= 0) heredocs.push([iniHeredoc, n]);

  return {
    mascara,
    comentarios,
    heredocs,
    abertosNoFim: (corpoDeHeredoc ? 1 : 0) + pendentes.length,
  };
}

/** Remove os comentários `#` de uma fonte shell, preservando a contagem de linhas. */
export function removerComentariosShell(fonte: string): string {
  const { comentarios } = lerContextoShell(fonte);
  if (comentarios.length === 0) return fonte;
  const partes: string[] = [];
  let cursor = 0;
  for (const [ini, fim] of comentarios) {
    partes.push(fonte.slice(cursor, ini));
    cursor = fim;
  }
  partes.push(fonte.slice(cursor));
  return partes.join('');
}

/**
 * Máscara de CONTEXTO: 1 = contexto de comando/palavra, 0 = dentro de um literal.
 *
 * Por que um gate precisa disto: `motivo="psql-ro ausente ($PSQL)"` põe a variável numa posição
 * sintaticamente idêntica à de uma invocação (logo depois de um `(`), mas é PROSA. Contá-la infla
 * o denominador do fiscal com sítios que não executam nada — e denominador inflado adoece igual a
 * denominador ausente: vira número que ninguém consegue auditar.
 *
 * Corpo de heredoc conta como contexto de comando (1): ali mora script GERADO, e é a direção
 * fail-closed — o fiscal prefere olhar um wrapper-fake a mais do que perder um script de verdade.
 */
export function mascaraContexto(fonte: string): Uint8Array {
  return lerContextoShell(fonte).mascara;
}

const naoVazias = (s: string) => s.split('\n').filter((l) => l.trim() !== '').length;

/** Alarme de fumaça: que FRAÇÃO das linhas não-vazias sobreviveu à limpeza. */
export function medirPreservacaoShell(fonte: string): {
  linhasOriginais: number;
  linhasPreservadas: number;
  fracao: number;
} {
  const linhasOriginais = naoVazias(fonte);
  const linhasPreservadas = naoVazias(removerComentariosShell(fonte));
  return {
    linhasOriginais,
    linhasPreservadas,
    fracao: linhasOriginais === 0 ? 1 : linhasPreservadas / linhasOriginais,
  };
}

/**
 * Alarme CALIBRADO: o maior BLOCO CONTÍGUO de linhas que a limpeza descartou (mesma razão do
 * irmão JS — a fração é grossa demais para separar cabeçalho honesto de desabamento).
 */
export function maiorBlocoDescartadoShell(fonte: string): number {
  const antes = fonte.split('\n');
  const depois = removerComentariosShell(fonte).split('\n');
  let maior = 0;
  let atual = 0;
  for (let i = 0; i < antes.length; i++) {
    if (antes[i].trim() === '') continue;
    atual = (depois[i] ?? '').trim() === '' ? atual + 1 : 0;
    if (atual > maior) maior = atual;
  }
  return maior;
}

/**
 * Sensor do lado INVERSO do desabamento: quantas linhas de comentário SOBREVIVERAM à limpeza,
 * FORA de corpo de heredoc (onde `#` é dado legítimo e deve mesmo sobreviver).
 *
 * Os dois alarmes acima vigiam o stripper comendo demais. Este vigia o oposto — o stripper que
 * PARA de limpar. Foi exatamente o que os dois furos desta máquina produziram (`<<<` lido como
 * `<<`: 45 comentários sobreviventes; `$(` dentro de `"…"`: 30). Nenhum dos outros dois alarmes
 * viu, porque nenhum mede sub-limpeza. Um gate que mede código sobre fonte não-limpa passa a medir
 * também os 200 lugares onde este repo DOCUMENTA o padrão proibido.
 */
export function comentariosSobreviventes(fonte: string): number {
  const { mascara, comentarios, heredocs } = lerContextoShell(fonte);
  const removidos = new Set(comentarios.map(([ini]) => ini));
  const emHeredoc = (idx: number) => heredocs.some(([a, b]) => idx >= a && idx < b);

  let n = 0;
  let off = 0;
  for (const linha of fonte.split('\n')) {
    const m = /^[ \t]*#/.exec(linha);
    if (m && !linha.trimStart().startsWith('#!')) {
      const idx = off + m[0].length - 1;
      // `mascara[idx] === 1` exclui o `#` que vive DENTRO de um literal — o programa awk/sed
      // embutido em `'…'` (`pipestatus-zsh-guard.sh` tem 37 deles) tem comentário da OUTRA
      // linguagem, e apagá-lo seria o erro, não preservá-lo.
      if (!removidos.has(idx) && !emHeredoc(idx) && mascara[idx] === 1) n++;
    }
    off += linha.length + 1;
  }
  return n;
}

/**
 * Fatia um trecho de shell em PALAVRAS, do jeito que o shell fatia: espaço/tab só separam quando
 * estão fora de aspas. `-F'|'` é UMA palavra; `-c "SELECT 1;\n  FROM x"` são DUAS, e a segunda
 * carrega a quebra de linha.
 *
 * Devolve, para cada palavra, o texto CRU e o `prefixoNu` — a parte antes da primeira aspa, que é
 * onde vive o flag (`-F'|'` → `-F`). Comparar flag contra o texto cru confundiria `-F'|'` com um
 * cluster de opções que contém `|`.
 */
export function fatiarPalavras(trecho: string): { cru: string; prefixoNu: string }[] {
  const palavras: { cru: string; prefixoNu: string }[] = [];
  const mascara = mascaraContexto(trecho);
  let cru = '';
  let prefixoNu = '';
  let nuFechado = false;

  const fechar = () => {
    if (cru !== '') palavras.push({ cru, prefixoNu });
    cru = '';
    prefixoNu = '';
    nuFechado = false;
  };

  for (let i = 0; i < trecho.length; i++) {
    const c = trecho[i];
    const foraDeLiteral = mascara[i] === 1;
    if (foraDeLiteral && (c === ' ' || c === '\t' || c === '\n')) { fechar(); continue; }
    cru += c;
    if (!foraDeLiteral || c === '"' || c === "'" || c === '\\') nuFechado = true;
    else if (!nuFechado) prefixoNu += c;
  }
  fechar();
  return palavras;
}

/**
 * Quantos heredocs esta máquina abriu e NUNCA fechou até o fim do arquivo.
 *
 * É o alarme INDEPENDENTE — e ele existe por uma falha que a matriz de sabotagem revelou:
 * `comentariosSobreviventes` isenta o que está dentro de heredoc (ali `#` é dado), e pergunta
 * isso à MESMA máquina. Então uma falha que faz a máquina *acreditar* estar num heredoc é
 * invisível para ele: o sensor consulta a crença defeituosa e a usa como desculpa. Foi exatamente
 * o que a sabotagem do `<<<` produziu — 45 comentários deixaram de ser limpos e o contador
 * devolveu 0.
 *
 * A invariante que não depende dessa crença: **script shell bem-formado não termina com heredoc
 * aberto**. Quando `<<<` é lido como `<<`, o delimitador vira o ARGUMENTO (`$REQ_IDS`), que nunca
 * aparece como linha — e o heredoc fica aberto até o EOF. Medido nos 373 `.sh` do repo: 0.
 *
 * A lição maior: sensor que consulta o próprio sistema que vigia herda os defeitos dele. Todo
 * alarme de stripper precisa de ao menos um eixo medido POR FORA da máquina.
 */
export function heredocsAbertos(fonte: string): number {
  return lerContextoShell(fonte).abertosNoFim;
}
