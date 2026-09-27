import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  JUIZES,
  PISOS,
  analisar,
  detectar,
  julgarNucleo,
  lerCorpoDoRepo,
  lerNucleo,
  veredito,
  type Analise,
  type Juiz,
} from './falsificar-exige-assert-gate';

/**
 * Dente do fiscal "o vermelho da falsificação tem de ser do assert" (docs/historico/falsificacao-
 * exit-nao-e-dente.md). Roda no CI por `bun run test` — puramente textual, não executa shell. As
 * mutações que provam que cada bloco abaixo tem dente vivem em
 * `scripts/mutcheck.d/falsificar-exige-assert.mut`.
 *
 * ⚠️ Fonte de teste vai em aspas SIMPLES ou DUPLAS do TS, nunca em template literal: lá `${…}` é
 * interpolação do próprio TS, e `${item#*:}` testaria outra string.
 */

// `import.meta.dir` é do Bun e não existe no vitest — `import.meta.url` existe nos dois.
const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const ALVO = 'db/test-data-health-sync-reprocess.sh';
const real = (caminho: string) => readFileSync(resolve(RAIZ, caminho), 'utf8');
const regras = (caminho: string, fonte: string) => detectar(caminho, fonte).violacoes.map((v) => v.regra);

/** O laço de ANTES do conserto (0906c17c2), recortado: o que abriu a classe. */
const LACO_ANTES = [
  'if [ "${1:-}" = "--falsificar" ]; then',
  '  SABOTAGENS="erro_nao_e_broken desconhecido_vira_ok nao_catalogada_vira_ok orfa_nunca_dispara',
  '              message_com_data_do_relogio message_constante fora_do_v_sources"',
  '  for sab in $SABOTAGENS; do',
  '    porta=$((porta+1))',
  '    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$LOGDIR/$sab.log" 2>&1; then',
  '      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa"; falhas=$((falhas+1))',
  '    else',
  '      quebrou="$(grep -c \'❌\' "$LOGDIR/$sab.log" || true)"',
  '      echo "  ✅ $sab — vermelha como devia ($quebrou assert(s) quebraram)"',
  '    fi',
  '  done',
  'fi',
].join('\n');

/** A forma das referências (push-vendedora, auto-aprovacao-piloto): a declaração vai DIRETO ao grep. */
const LACO_REFERENCIA = [
  '  SABOTAGENS="expediente_em_utc:E2 dia_ignorado:T11b',
  '              relogio_desligado:E1|E2|E3|E4"',
  '  for item in $SABOTAGENS; do',
  '    sab="${item%%:*}"; esperado="${item#*:}"',
  '    if bash "$0" > "$LOGDIR/$sab.log" 2>&1; then falhas=$((falhas+1))',
  '    elif grep -Eq "^ERROR:  ($esperado): " "$LOGDIR/$sab.log"; then echo ok',
  '    else falhas=$((falhas+1)); fi',
  '  done',
].join('\n');

/**
 * O idioma do #2606 (positivação): `nome:VERMELHOS:VERDES`, `ID!MARCA` para o erro de execução
 * DECLARADO, e três elos entre a declaração e o grep (resto → verm → for x → id/marca).
 */
const LACO_2606 = [
  '  SABOTAGENS="corpo_pre_fix:BU2,BU4:BS2,BS4',
  '              mes_em_utc:BU1,BS1:BU8,BS8,R0',
  '              sem_pin:R0!TRIPWIRE"',
  '  for item in $SABOTAGENS; do',
  '    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""',
  '    [ "$resto" != "$verm" ] && verdes="${resto#*:}"',
  '    for x in ${verm//,/ }; do',
  '      case "$x" in',
  '        *!*) id="${x%%!*}"; marca="${x#*!}"',
  '             grep -Eq "(^|[^A-Z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;',
  '        *)   grep -Eq "(^|[^A-Z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;',
  '      esac',
  '    done',
  '  done',
].join('\n');

describe('controle POSITIVO — se o detector parar de casar, isto fica vermelho', () => {
  it('o laço que abriu a classe: cada entrada nua é R1, e o laço que só lê o exit é R2', () => {
    const v = detectar(ALVO, LACO_ANTES).violacoes;
    expect(v.filter((x) => x.regra === 'R1').map((x) => x.detalhe.split('"')[1])).toEqual([
      'erro_nao_e_broken',
      'desconhecido_vira_ok',
      'nao_catalogada_vira_ok',
      'orfa_nunca_dispara',
      'message_com_data_do_relogio',
      'message_constante',
      'fora_do_v_sources',
    ]);
    expect(v.filter((x) => x.regra === 'R2')).toEqual([
      expect.objectContaining({ linha: 4, detalhe: expect.stringContaining('descarta a declaração') }),
    ]);
  });

  it('reintroduzir UMA entrada nua no alvo REAL fica vermelho (R1), apontando a linha da lista', () => {
    const fonte = real(ALVO);
    expect(regras(ALVO, fonte)).toEqual([]);
    const sabotado = fonte.replace('erro_nao_e_broken:A7,A9 ', 'erro_nao_e_broken ');
    expect(sabotado).not.toBe(fonte);
    const v = detectar(ALVO, sabotado).violacoes;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ regra: 'R1', linha: fonte.split('\n').findIndex((l) => l.includes('SABOTAGENS="')) + 1 });
  });

  it('o laço REAL que volta a descartar a declaração fica vermelho (R2)', () => {
    const fonte = real(ALVO);
    const sabotado = fonte.replace('exigidos="${item#*:}"', 'exigidos=""');
    expect(sabotado).not.toBe(fonte);
    expect(regras(ALVO, sabotado)).toEqual(['R2']);
  });

  it('o laço REAL que extrai a declaração mas julga por outra coisa fica vermelho (R2)', () => {
    const fonte = real(ALVO);
    const sabotado = fonte.replaceAll('($exigido)', '(A[0-9]+)');
    expect(sabotado).not.toBe(fonte);
    expect(detectar(ALVO, sabotado).violacoes).toEqual([
      expect.objectContaining({ regra: 'R2', detalhe: expect.stringContaining('nunca chega a um grep') }),
    ]);
  });

  it('curinga de regex na declaração é o defeito disfarçado — e declaração vazia também', () => {
    expect(regras('x.sh', 'SABOTAGENS="a:.* b:A1"\nfor i in $SABOTAGENS; do d="${i#*:}"; grep -q "$d" l; done')).toEqual(['R1']);
    expect(regras('x.sh', 'SABOTAGENS="a: b:A1"\nfor i in $SABOTAGENS; do d="${i#*:}"; grep -q "$d" l; done')).toEqual(['R1']);
    expect(regras('x.sh', 'SABOTAGENS="a:A1|"\nfor i in $SABOTAGENS; do d="${i#*:}"; grep -q "$d" l; done')).toEqual(['R1']);
  });

  it('a gramática tem DOIS grupos no máximo, e a marca do erro declarado não é vazia', () => {
    const laco = '\nfor i in $SABOTAGENS; do d="${i#*:}"; grep -q "$d" l; done';
    expect(regras('x.sh', 'SABOTAGENS="a:A1:B2:C3"' + laco)).toEqual(['R1']);
    expect(regras('x.sh', 'SABOTAGENS="a:A1!"' + laco)).toEqual(['R1']);
    expect(regras('x.sh', 'SABOTAGENS="a:!X"' + laco)).toEqual(['R1']);
  });

  it('grep DEPOIS do laço não julga sabotagem nenhuma — nem depois do `done`, nem depois de um laço de uma linha', () => {
    const depoisDoDone = ['SABOTAGENS="a:A1"', 'for i in $SABOTAGENS; do', '  d="${i#*:}"', '  bash "$0" || echo vermelha', 'done', 'grep -q "$d" log'];
    expect(regras('x.sh', depoisDoDone.join('\n'))).toEqual(['R2']);
    const umaLinha = 'SABOTAGENS="a:A1"\nfor i in $SABOTAGENS; do d="${i#*:}"; bash "$0"; done\ngrep -q "$d" log\n';
    expect(regras('x.sh', umaLinha)).toEqual(['R2']);
  });

  it('lista vazia não prova nada (R1), e lista que nenhum laço percorre é R2', () => {
    expect(regras('x.sh', 'SABOTAGENS=""\nfor i in $SABOTAGENS; do d="${i#*:}"; grep -q "$d" l; done')).toEqual(['R1']);
    expect(regras('x.sh', 'SABOTAGENS="a:A1 b:B2"\necho "$SABOTAGENS"\n')).toEqual(['R2']);
  });
});

describe('o que NÃO é a classe', () => {
  it('as três formas vivas passam: a das referências, a do alvo (via `for` interno) e o alvo REAL inteiro', () => {
    expect(detectar('x.sh', LACO_REFERENCIA)).toMatchObject({ listas: 1, entradas: 3, lacos: 1, violacoes: [] });
    const viaApelido = [
      'SABOTAGENS="a:A7,A9 b:A13"',
      'for item in $SABOTAGENS; do',
      '  exigidos="${item#*:}"',
      '  for exigido in ${exigidos//,/ }; do',
      '    grep -Eq "^  ❌ ($exigido) " "$log" || faltam="$faltam $exigido"',
      '  done',
      'done',
    ].join('\n');
    expect(detectar('x.sh', viaApelido).violacoes).toEqual([]);
    expect(detectar(ALVO, real(ALVO))).toMatchObject({ listas: 1, entradas: 13, lacos: 1, violacoes: [] });
  });

  it('o idioma do #2606 passa: nome:VERMELHOS:VERDES, ID!MARCA e a cadeia de 3 elos até o grep', () => {
    expect(detectar('x.sh', LACO_2606)).toMatchObject({ listas: 1, entradas: 3, lacos: 1, violacoes: [] });
  });

  it('grep quebrado em duas linhas com `\\` é UM comando — a declaração na continuação vale', () => {
    const fonte = ['SABOTAGENS="a:A1"', 'for i in $SABOTAGENS; do', '  d="${i#*:}"', '  grep -Eq \\', '    "^ERRO ($d)" "$log" || falhas=1', 'done'];
    expect(detectar('x.sh', fonte.join('\n')).violacoes).toEqual([]);
  });

  it('array com aspas por item, `local`/`readonly` e `##*:` também são o idioma', () => {
    const fonte = [
      "  local SABOTAGENS=( \"a:A1\" 'b:B2|B3' c:C4 )",
      '  for s in "${SABOTAGENS[@]}"; do',
      '    d="${s##*:}"',
      '    grep -q "$d FALHOU" "$log"',
      '  done',
    ].join('\n');
    expect(detectar('x.sh', fonte)).toMatchObject({ listas: 1, entradas: 3, lacos: 1, violacoes: [] });
  });

  it('SABOTAGENS como CONTADOR não é lista (o `scripts/test-setup-contrato.sh` de verdade)', () => {
    expect(detectar('x.sh', 'SABOTAGENS=0\nSABOTAGENS=$((SABOTAGENS + 1))\n')).toMatchObject({ listas: 0, violacoes: [] });
  });

  it('comentário é a ÚNICA isenção — e quem decide é o stripper compartilhado (`#` em aspas é dado)', () => {
    expect(detectar('x.sh', '# SABOTAGENS="a b c"\n# for s in $SABOTAGENS; do\n')).toMatchObject({ listas: 0, lacos: 0 });
    // `#` dentro de aspas (e de `${i#*:}`) é dado: uma regex local apagaria a lista e o laço — verde por cegueira
    expect(regras('x.sh', 'x="#"; SABOTAGENS="nua"\nfor i in $SABOTAGENS; do d="${i#*:}"; grep -q "$d" l; done')).toEqual(['R1']);
  });

  it('a linha reportada é a da FONTE (a limpeza preserva o número de linhas)', () => {
    const fonte = '#!/usr/bin/env bash\n# comentário\n\nSABOTAGENS="nua"\n';
    expect(detectar('x.sh', fonte).violacoes[0]).toMatchObject({ regra: 'R1', linha: 4 });
  });
});

describe('R3 — cada falsificar=<n> do núcleo tem juiz, e o juiz tem as âncoras', () => {
  const juizes: Record<string, Juiz> = { 'db/a.sh': { motivo: 'm', ancoras: ['confere "$marca"'] } };
  const limpos = new Map([
    ['db/a.sh', 'x=1\nconfere "$marca"\n'],
    ['db/b.sh', 'y=2\n'],
  ]);

  it('lerNucleo pega só `falsificar=<n>` — fora-do-ci, sem terceiro campo e comentário ficam fora', () => {
    const manifesto = [
      '#db/zz.sh 10 falsificar=3', // linha comentada que, lida, CASARIA o formato
      'db/a.sh     12  falsificar=4',
      'db/b.sh     30',
      'db/c.sh     8   falsificar=fora-do-ci',
    ].join('\n');
    expect(lerNucleo(manifesto)).toEqual([{ arquivo: 'db/a.sh', linha: 2 }]);
  });

  it('com juiz e âncoras presentes, limpo', () => {
    expect(julgarNucleo([{ arquivo: 'db/a.sh', linha: 2 }], limpos, juizes)).toEqual([]);
  });

  it('falsificar=<n> SEM juiz registrado → R3 no manifesto, na linha dele', () => {
    expect(julgarNucleo([{ arquivo: 'db/b.sh', linha: 7 }], limpos, juizes)).toEqual([
      expect.objectContaining({ regra: 'R3', arquivo: 'db/nucleo-ci.txt', linha: 7 }),
    ]);
  });

  it('âncora que sumiu do código → R3 (inclusive a que só sobrou num COMENTÁRIO)', () => {
    expect(julgarNucleo([], new Map([['db/a.sh', 'x=1\n']]), juizes).map((v) => v.regra)).toEqual(['R3']);
    const d = analisar([{ caminho: 'db/a.sh', fonte: 'x=1\n# confere "$marca"\n' }], 'db/a.sh 1 falsificar=1\n', juizes);
    expect(d.violacoes.map((v) => v.detalhe)).toEqual([expect.stringContaining('âncora do juiz sumiu')]);
  });

  it('arquivo do núcleo no idioma SABOTAGENS limpo se prova sozinho — sem registro', () => {
    expect(analisar([{ caminho: 'db/i.sh', fonte: LACO_REFERENCIA }], 'db/i.sh 5 falsificar=3\n', {}).violacoes).toEqual([]);
  });

  it('idioma COM violação não dispensa o juiz: R1, R2 e R3 juntos', () => {
    const r = analisar([{ caminho: 'db/i.sh', fonte: LACO_ANTES }], 'db/i.sh 5 falsificar=3\n', {});
    expect(new Set(r.violacoes.map((v) => v.regra))).toEqual(new Set(['R1', 'R2', 'R3']));
  });

  it('arquivo do núcleo SEM lista e sem juiz → R3 (não ter lista não é estar limpo)', () => {
    expect(analisar([{ caminho: 'db/j.sh', fonte: 'x=1\n' }], 'db/j.sh 5 falsificar=3\n', {}).violacoes.map((v) => v.regra)).toEqual([
      'R3',
    ]);
  });

  it('juiz registrado para arquivo que o fiscal não leu → R3 (renomear não apaga o dever)', () => {
    expect(julgarNucleo([], new Map(), juizes)).toEqual([expect.objectContaining({ regra: 'R3', arquivo: 'db/a.sh' })]);
  });

  it('cada juiz REAL do núcleo: remover QUALQUER âncora do arquivo real fica vermelho', () => {
    for (const [arquivo, juiz] of Object.entries(JUIZES)) {
      const fonte = real(arquivo);
      expect(juiz.ancoras.length, arquivo).toBeGreaterThan(0);
      for (const ancora of juiz.ancoras) {
        expect(fonte.includes(ancora), `${arquivo}: ${ancora}`).toBe(true);
        const sem = fonte.split(ancora).join('');
        const v = julgarNucleo([], new Map([[arquivo, sem]]), { [arquivo]: juiz });
        expect(v.map((x) => x.detalhe), `${arquivo}: ${ancora}`).toEqual([expect.stringContaining(ancora)]);
      }
    }
  });
});

describe('veredito — 2 nunca é "passou"', () => {
  const base = (over: Partial<Analise> = {}): Analise => ({
    caminhos: ['x.sh'],
    listas: 0,
    entradas: 0,
    lacos: 0,
    linhasNucleo: null,
    violacoes: [],
    alarmes: [],
    ...over,
  });
  const noPiso = (): Analise =>
    base({
      caminhos: Object.entries(PISOS.arquivosPorRaiz).flatMap(([raiz, n]) => Array.from({ length: n }, (_, i) => `${raiz}/f${i}.sh`)),
      listas: PISOS.listas,
      entradas: PISOS.entradas,
      lacos: PISOS.lacos,
      linhasNucleo: PISOS.linhasFalsificarNucleo,
    });

  it('limpo, sem pisos → 0', () => {
    expect(veredito(base(), false).codigo).toBe(0);
  });

  it('com violação → 1, e a saída aponta regra, arquivo:linha e o diário', () => {
    const r = veredito(base({ violacoes: [{ regra: 'R1', arquivo: 'db/x.sh', linha: 9, detalhe: 'entrada "a"' }] }), false);
    expect(r.codigo).toBe(1);
    expect(r.linhas.join('\n')).toContain('[R1] db/x.sh:9');
    expect(r.linhas.join('\n')).toContain('docs/historico/falsificacao-exit-nao-e-dente.md');
  });

  it('nenhum arquivo lido → 2 (ausente ≠ zero violações)', () => {
    expect(veredito(base({ caminhos: [] }), false).codigo).toBe(2);
  });

  it('alarme do stripper → 2, mesmo com violação à vista', () => {
    const r = base({ alarmes: ['x.sh: bloco'], violacoes: [{ regra: 'R1', arquivo: 'x.sh', linha: 1, detalhe: 'd' }] });
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('ponta a ponta, com a máquina real: heredoc sem delimitador vira INDETERMINADO, não "limpo"', () => {
    const fonte = 'cat <<EOF\n' + 'linha\n'.repeat(30);
    expect(veredito(analisar([{ caminho: 'x.sh', fonte }]), false).codigo).toBe(2);
  });

  it('com pisos: exatamente nos pisos passa (controle dos casos de baixo)', () => {
    expect(veredito(noPiso(), true).codigo).toBe(0);
  });

  it.each([
    ['listas', { listas: PISOS.listas - 1 }],
    ['entradas', { entradas: PISOS.entradas - 1 }],
    ['laços', { lacos: PISOS.lacos - 1 }],
    ['linhas do núcleo', { linhasNucleo: PISOS.linhasFalsificarNucleo - 1 }],
    ['manifesto não lido', { linhasNucleo: null }],
  ])('com pisos: %s abaixo do piso → 2', (_nome, over) => {
    expect(veredito({ ...noPiso(), ...over }, true).codigo).toBe(2);
  });

  it('com pisos: perder UMA raiz fura o piso dela, mesmo com o total folgado', () => {
    const sem = noPiso().caminhos.filter((c) => !c.startsWith('connector/'));
    expect(veredito({ ...noPiso(), caminhos: [...sem, ...sem] }, true).codigo).toBe(2);
  });
});

describe('o corpo REAL do repo', () => {
  const { arquivos, manifesto } = lerCorpoDoRepo(RAIZ);
  const r = analisar(arquivos, manifesto);

  it('toda linha falsificar=<n> do núcleo é julgada — pelo idioma limpo ou por juiz — e o manifesto não voltou vazio', () => {
    expect(manifesto).not.toBeNull();
    const nucleo = lerNucleo(manifesto ?? '');
    expect(nucleo.length).toBeGreaterThanOrEqual(PISOS.linhasFalsificarNucleo);
    for (const { arquivo } of nucleo) {
      const fonte = arquivos.find((a) => a.caminho === arquivo)?.fonte;
      expect(fonte, arquivo).toBeDefined();
      const d = detectar(arquivo, fonte ?? '');
      expect(arquivo in JUIZES || (d.listas > 0 && d.violacoes.length === 0), arquivo).toBe(true);
    }
  });

  it('nenhum veredito de falsificação aceita vermelho que não é do assert', () => {
    expect(r.violacoes).toEqual([]);
  });

  it('o fiscal MEDIU e o stripper não desabou: com pisos, o veredito é 0 — não 2', () => {
    const v = veredito(r, true);
    expect(v.linhas.join('\n')).not.toContain('INDETERMINADO');
    expect(v.codigo).toBe(0);
  });
});
