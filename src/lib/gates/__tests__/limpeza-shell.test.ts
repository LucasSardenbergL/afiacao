import { describe, expect, it } from 'vitest';

import {
  comentariosSobreviventes,
  diagnosticarShell,
  heredocsAbertos,
  fatiarPalavras,
  maiorBlocoDescartadoShell,
  mascaraContexto,
  medirPreservacaoShell,
  removerComentariosShell,
} from '../limpeza-shell';

/**
 * Dente do stripper SHELL. Os dois casos de regressão no fim (`<<<` e `$(` dentro de `"…"`) não
 * são hipotéticos: são os dois furos que esta máquina teve enquanto nascia, achados pelo sensor
 * `comentariosSobreviventes` e não pelos alarmes de sobre-limpeza — que é a lição embutida aqui.
 */
describe('removerComentariosShell', () => {
  it('remove comentário de linha e preserva a contagem de linhas', () => {
    const fonte = 'a=1\n# comentário\nb=2\n';
    expect(removerComentariosShell(fonte)).toBe('a=1\n\nb=2\n');
    expect(removerComentariosShell(fonte).split('\n').length).toBe(fonte.split('\n').length);
  });

  it('só trata `#` como comentário quando ele COMEÇA palavra', () => {
    const fonte = 'x="${par#*=}"\ny=${#lista[@]}\nz=a#b\n';
    expect(removerComentariosShell(fonte)).toBe(fonte);
  });

  it('preserva `#` dentro de aspas simples, duplas e $\'…\'', () => {
    const fonte = `a='# não é comentário'\nb="# nem isto"\nc=$'# nem isto'\n`;
    expect(removerComentariosShell(fonte)).toBe(fonte);
  });

  it('preserva o corpo do heredoc verbatim — ali `#` é DADO', () => {
    const fonte = ['cat > f <<EOF', '#!/usr/bin/env bash', '# isto vai para o arquivo gerado', 'EOF', '# isto não', ''].join('\n');
    const limpo = removerComentariosShell(fonte);
    expect(limpo).toContain('# isto vai para o arquivo gerado');
    expect(limpo.split('\n')[4]).toBe('');
  });

  it('respeita `<<-` (delimitador recuado por TAB)', () => {
    const fonte = ['cat <<-EOF', '\t# dado', '\tEOF', '# comentário', ''].join('\n');
    const limpo = removerComentariosShell(fonte);
    expect(limpo).toContain('\t# dado');
    expect(limpo.split('\n')[3]).toBe('');
  });

  it('aspas atravessam a quebra de linha, como manda o shell', () => {
    const fonte = ['q="SELECT 1', '-- # não é comentário de shell', 'FROM t"', '# comentário', ''].join('\n');
    const limpo = removerComentariosShell(fonte);
    expect(limpo).toContain('-- # não é comentário de shell');
    expect(limpo.split('\n')[3]).toBe('');
  });

  // ── REGRESSÃO 1: `<<<` é herestring, não heredoc ──────────────────────────────────────────
  // Parar no primeiro `<` fazia o segundo virar um `<<` sozinho; o delimitador lido virava o
  // ARGUMENTO (`$LISTA`), que nunca fecha, e todo o resto do arquivo virava "corpo de heredoc".
  // Medido em `.claude/skills/fecho/scripts/edges-pendentes.sh:228`: 45 comentários sobreviveram.
  it('`<<<` não abre corpo de heredoc — o resto do arquivo continua sendo limpo', () => {
    const fonte = ['IFS="," read -r -a p <<< "$LISTA"', '# comentário depois do herestring', 'x=1', ''].join('\n');
    expect(removerComentariosShell(fonte).split('\n')[1]).toBe('');
    expect(comentariosSobreviventes(fonte)).toBe(0);
  });

  // ── REGRESSÃO 2: `$(…)` dentro de `"…"` volta ao contexto de comando ───────────────────────
  // Sem a pilha, o primeiro `"` pareava com o `"` de `"$input"` e tudo desandava dali em diante.
  // Medido em `.claude/hooks/heavy-guard.sh:28`: 30 comentários sobreviveram.
  it('`$(…)` dentro de aspas duplas não dessincroniza o resto do arquivo', () => {
    const fonte = [
      `cmd="$(printf '%s' "$input" | sed -n 's|.*x.*|y|p')"`,
      '# comentário depois da substituição aninhada',
      'x=1',
      '',
    ].join('\n');
    expect(removerComentariosShell(fonte).split('\n')[1]).toBe('');
    expect(comentariosSobreviventes(fonte)).toBe(0);
  });

  // O sensor de sub-limpeza ISENTA o que está dentro de heredoc — e pergunta isso à MESMA
  // máquina. Uma falha que faz a máquina ACHAR que está num heredoc é, portanto, invisível para
  // ele. A matriz de sabotagem mediu: com o `<<<` quebrado, `edges-pendentes.sh` deixava 45
  // comentários por limpar e `comentariosSobreviventes` devolvia 0. Daí o alarme independente.
  it('heredoc aberto até o EOF é o alarme que NÃO depende da crença da máquina', () => {
    expect(heredocsAbertos('IFS="," read -r -a p <<< "$LISTA"\n# c\nx=1\n')).toBe(0);
    expect(heredocsAbertos('cat <<EOF\nlinha\nEOF\n')).toBe(0);
    expect(heredocsAbertos('cat <<NUNCA_FECHA\nlinha\n')).toBe(1);
  });

  it('`comentariosSobreviventes` ignora `#!`, heredoc e comentário de linguagem embutida', () => {
    const fonte = [
      '#!/usr/bin/env bash',
      "awk '",
      '  # comentário do AWK, dentro de literal — apagá-lo é que seria o erro',
      "  {print}' arq",
      'cat <<EOF',
      '# dado do heredoc',
      'EOF',
      '',
    ].join('\n');
    expect(comentariosSobreviventes(fonte)).toBe(0);
  });
});

describe('mascaraContexto', () => {
  it('marca 0 dentro de literal e 1 em contexto de comando', () => {
    const fonte = 'motivo="ausente ($PSQL)"\n"$PSQL" -c x\n';
    const m = mascaraContexto(fonte);
    expect(m[fonte.indexOf('$PSQL)')]).toBe(0);
    expect(m[fonte.indexOf('"$PSQL" -c')]).toBe(1);
  });

  it('`$(…)` dentro de `"…"` volta a ser contexto de comando', () => {
    const fonte = 'RAW="$("$PSQL" -f q.sql)"\n';
    const m = mascaraContexto(fonte);
    expect(m[fonte.indexOf('"$PSQL"')]).toBe(1);
  });
});

describe('fatiarPalavras', () => {
  it('separa por espaço FORA de aspas e devolve o prefixo nu do flag', () => {
    const p = fatiarPalavras(`"$P" -At -F'|' -c "SELECT 1;\n FROM t"`);
    expect(p.map((x) => x.prefixoNu)).toEqual(['', '-At', '-F', '-c', '']);
    expect(p).toHaveLength(5);
    expect(p[4].cru).toContain('FROM t');
  });
});

describe('alarmes do stripper', () => {
  it('fonte sem comentário preserva tudo e descarta bloco zero', () => {
    const fonte = 'a=1\nb=2\n';
    expect(medirPreservacaoShell(fonte).fracao).toBe(1);
    expect(maiorBlocoDescartadoShell(fonte)).toBe(0);
  });

  it('mede o maior bloco CONTÍGUO descartado, ignorando linha vazia do original', () => {
    const fonte = ['# a', '# b', '', '# c', 'x=1', '# d', ''].join('\n');
    expect(maiorBlocoDescartadoShell(fonte)).toBe(3);
  });
});

/**
 * `diagnosticarShell` existe para não repetir a varredura quatro vezes — mas função combinada que
 * substitui quatro é exatamente a forma que já divergiu neste arquivo (limpeza vs. máscara eram
 * duas máquinas, e discordaram). Esta paridade é o que impede a repetição: se um dos cinco campos
 * sair diferente do alarme que ele resume, o dente reprova em vez de o CLI medir outra coisa que
 * o teste unitário.
 */
describe('paridade diagnosticarShell × os alarmes que ele resume', () => {
  const corpos = [
    'a=1\n# c\nb=2\n',
    ['cat <<EOF', '# dado', 'EOF', '# comentário', ''].join('\n'),
    ['IFS="," read -r -a p <<< "$L"', '# depois do herestring', 'x=1', ''].join('\n'),
    [`cmd="$(printf '%s' "$i" | sed -n 's|a|b|p')"`, '# depois da substituição', 'y=2', ''].join('\n'),
    'cat <<NUNCA_FECHA\nlinha\n',
    ["awk '", '  # comentário do awk', "  {print}' arq", ''].join('\n'),
    '',
  ];

  it.each(corpos.map((c, i) => [i, c]))('corpo %i', (_i, fonte) => {
    const d = diagnosticarShell(fonte as string);
    const m = medirPreservacaoShell(fonte as string);
    expect(d.linhasOriginais).toBe(m.linhasOriginais);
    expect(d.fracaoPreservada).toBe(m.fracao);
    expect(d.maiorBlocoDescartado).toBe(maiorBlocoDescartadoShell(fonte as string));
    expect(d.comentariosSobreviventes).toBe(comentariosSobreviventes(fonte as string));
    expect(d.heredocsAbertos).toBe(heredocsAbertos(fonte as string));
  });
});
