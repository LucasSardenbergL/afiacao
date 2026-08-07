import { describe, expect, it } from 'vitest';
import {
  type Achado,
  auditarIndices,
  type DirIndice,
  lerDiretoriosIndexados,
  parseEntradas,
  RESUMO_MIN_CHARS,
} from './docs-indice-gate-check';

/** Resumo honesto de referência — acima do piso, como toda entrada real do índice. */
const RESUMO = 'entrega do PR #1234 — 3 bugs, 2 lições e o número que provou';

const linha = (f: string, resumo = RESUMO) => `| [${f}](${f}) | ${resumo} |`;

/** Índice mínimo no formato real (tabela de duas colunas com link relativo). */
function indice(...linhas: string[]): string {
  return `# docs/x/ — diário\n\n| Arquivo | O que tem |\n| --- | --- |\n${linhas.join('\n')}\n`;
}

const dir = (readme: string, arquivos: string[]): DirIndice[] => [
  { dir: 'docs/x', readme, arquivos },
];

const msgs = (a: Achado[]) => a.map((f) => f.msg).join(' | ');

describe('parseEntradas — o que conta como entrada do índice', () => {
  it('lê uma linha de dados normal', () => {
    const e = parseEntradas(indice(linha('pcp.md')));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ arquivo: 'pcp.md', texto: 'pcp.md', resumo: RESUMO });
  });

  it('ignora cabeçalho e separador (`| Arquivo |`, `| --- |`)', () => {
    expect(parseEntradas(indice())).toHaveLength(0);
  });

  it('aceita `](x.md)` e `](./x.md)`', () => {
    const e = parseEntradas(indice(linha('a.md'), '| [./b.md](./b.md) | ' + RESUMO + ' |'));
    expect(e.map((x) => x.arquivo)).toEqual(['a.md', 'b.md']);
  });

  // Linkar a seção certa de um doc longo é uso normal de markdown; sem a âncora opcional o gate
  // acusaria "órfão" um arquivo que ESTÁ indexado — o falso-positivo mais provável desta regra.
  it('aceita âncora: `](x.md#secao)` indexa x.md', () => {
    const e = parseEntradas(indice(`| [a.md](a.md#o-achado) | ${RESUMO} |`));
    expect(e.map((x) => x.arquivo)).toEqual(['a.md']);
  });

  it('arquivo com âncora não vira órfão', () => {
    expect(auditarIndices(dir(indice(`| [a.md](a.md#topo) | ${RESUMO} |`), ['a.md']))).toHaveLength(0);
  });

  // O DISCRIMINANTE deste gate, e a razão de ele ler a 1ª coluna em vez do arquivo inteiro.
  // Estado real do índice do histórico: `setup-agente.md` é citado no resumo de
  // `melhorias-code-2026-07.md`, e a versão anterior (matchAll no README inteiro) dava por indexado
  // um doc sem linha nenhuma.
  it('link CITADO no resumo de outra entrada NÃO conta como entrada própria', () => {
    const citando = `diagnóstico das 240 sessões; execução em [setup-agente.md](setup-agente.md)`;
    const e = parseEntradas(indice(linha('melhorias-code-2026-07.md', citando)));
    expect(e.map((x) => x.arquivo)).toEqual(['melhorias-code-2026-07.md']);
  });

  it('link em PROSA (fora da tabela) não conta', () => {
    expect(parseEntradas(`# t\n\nveja [pcp.md](pcp.md) para o detalhe.\n`)).toHaveLength(0);
  });

  // Link para FORA do diretório não indexa o arquivo local: o índice de um diretório só responde
  // pelos arquivos dele, e casar `../agent/x.md` como `x.md` daria indexação fantasma.
  it('IGNORA link para outro diretório e para a web', () => {
    const e = parseEntradas(
      indice(
        `| [a](../agent/a.md) | ${RESUMO} |`,
        `| [b](https://ex.com/b.md) | ${RESUMO} |`,
        `| [c](docs/historico/c.md) | ${RESUMO} |`,
      ),
    );
    expect(e).toHaveLength(0);
  });

  it('README sem tabela não indexa nada (não vira passe-livre)', () => {
    expect(parseEntradas('# só prosa, zero tabela')).toHaveLength(0);
  });

  it('`|` dentro do resumo (código inline) não quebra o parse nem trunca o resumo', () => {
    const r = 'o pipe `cmd | tail` engole o exit code — medido em 3 sessões';
    const e = parseEntradas(indice(linha('worktrees.md', r)));
    expect(e).toHaveLength(1);
    expect(e[0].resumo).toBe(r);
  });

  it('reporta a LINHA da entrada (clicável no editor)', () => {
    const e = parseEntradas(indice(linha('a.md'), linha('b.md')));
    expect(e[1].line).toBe(e[0].line + 1);
  });
});

describe('auditarIndices — invariante 1: arquivo ÓRFÃO (o bug do #1659/#1212)', () => {
  it('passa quando todo arquivo está no índice', () => {
    expect(auditarIndices(dir(indice(linha('a.md'), linha('b.md')), ['a.md', 'b.md']))).toHaveLength(0);
  });

  it('FALHA com um arquivo fora do índice — a forma exata do #1659', () => {
    const a = auditarIndices(dir(indice(linha('a.md')), ['a.md', 'programa-cabreuva-colacor.md']));
    expect(a).toHaveLength(1);
    expect(a[0].arquivo).toBe('programa-cabreuva-colacor.md');
    expect(a[0].level).toBe('error');
    expect(a[0].dir).toBe('docs/x');
  });

  it('FALHA com os 9 invisíveis que o #1658 reconciliou à mão', () => {
    const nove = [
      'auditoria-health-2026-07-06.md',
      'ci-testes-edge-deno.md',
      'melhorias-code-2026-07.md',
      'modularizacao.md',
      'pcp.md',
      'piso-de-contexto.md',
      'reposicao-embalagem-captura.md',
      'revisao-completa-2026-07-04.md',
      'setup-agente.md',
    ];
    expect(auditarIndices(dir(indice(linha('a.md')), ['a.md', ...nove]))).toHaveLength(9);
  });

  // A mensagem tem de dizer por que o CI estava VERDE — senão quem lê acha que é falha de build.
  it('a mensagem explica que o doc fica INVISÍVEL e entrega a linha PRONTA para colar', () => {
    const a = auditarIndices(dir(indice(linha('a.md')), ['a.md', 'novo.md']));
    expect(a[0].msg).toContain('invisível');
    expect(a[0].msg).toContain('docs/x/README.md');
    expect(a[0].msg).toContain('| [novo.md](novo.md) |');
  });

  // ⚠️ A ASSERÇÃO DO DISCRIMINANTE. Trocar este invariante pela busca solta que ele substituiu
  // (`readme.includes('(' + arquivo + ')')`, que é como se confere isso à mão) tem de deixar ESTE
  // teste vermelho — senão a suíte não sabe distinguir "tem linha própria" de "foi citado".
  it('doc apenas CITADO no resumo alheio continua ÓRFÃO (o falso-negativo da busca solta)', () => {
    const citando = `diagnóstico das 240 sessões; execução em [setup-agente.md](setup-agente.md)`;
    const idx = indice(linha('melhorias-code-2026-07.md', citando));

    expect(idx).toContain('(setup-agente.md)'); // a busca solta acharia e daria por indexado

    const a = auditarIndices(dir(idx, ['melhorias-code-2026-07.md', 'setup-agente.md']));
    expect(a).toHaveLength(1);
    expect(a[0].arquivo).toBe('setup-agente.md');
    expect(a[0].msg).toContain('invisível');
  });

  it('a AUSÊNCIA de linha não tem número de linha para apontar (line 0)', () => {
    const a = auditarIndices(dir(indice(linha('a.md')), ['a.md', 'novo.md']));
    expect(a[0].line).toBe(0);
  });
});

describe('auditarIndices — invariante 2: LINK QUEBRADO (a direção oposta)', () => {
  it('FALHA quando o índice aponta para arquivo que não existe', () => {
    const a = auditarIndices(dir(indice(linha('a.md'), linha('sumiu.md')), ['a.md']));
    expect(a).toHaveLength(1);
    expect(a[0].arquivo).toBe('sumiu.md');
    expect(a[0].msg).toContain('NÃO existe');
    expect(a[0].line).toBeGreaterThan(0);
  });

  it('renomeação pela metade acusa NOS DOIS lados (órfão + link quebrado)', () => {
    const a = auditarIndices(dir(indice(linha('nome-velho.md')), ['nome-novo.md']));
    expect(a).toHaveLength(2);
    expect(msgs(a)).toContain('nome-novo.md');
    expect(msgs(a)).toContain('nome-velho.md');
  });

  // O README É o índice; ele existir na própria tabela é redundante, não é link morto.
  it('entrada apontando para o próprio README.md não é acusada de link quebrado', () => {
    expect(auditarIndices(dir(indice(linha('README.md')), []))).toHaveLength(0);
  });
});

describe('auditarIndices — invariante 3: DUPLICATA (append de duas worktrees paralelas)', () => {
  it('FALHA com o mesmo doc em duas linhas — o git aceita o merge das duas, sem conflito', () => {
    const a = auditarIndices(
      dir(indice(linha('pcp.md'), linha('pcp.md', 'outro resumo, escrito noutra sessão')), ['pcp.md']),
    );
    expect(a).toHaveLength(1);
    expect(a[0].arquivo).toBe('pcp.md');
    expect(a[0].msg).toContain('2 entradas');
  });

  it('aponta a linha da SEGUNDA entrada (a que sobra)', () => {
    const idx = indice(linha('a.md'), linha('pcp.md'), linha('pcp.md', 'resumo da outra sessão paralela'));
    const a = auditarIndices(dir(idx, ['a.md', 'pcp.md']));
    expect(a).toHaveLength(1);
    expect(a[0].line).toBe(parseEntradas(idx)[2].line);
  });
});

describe('auditarIndices — invariante 4: TEXTO do link = DESTINO', () => {
  it('FALHA com `[a.md](b.md)` (copiar-colar de outra linha)', () => {
    const a = auditarIndices(dir(indice(`| [a.md](b.md) | ${RESUMO} |`), ['b.md']));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain('diverge do destino');
  });

  it('`./` e âncora são ruído de forma, não divergência', () => {
    const idx = indice(`| [a.md](./a.md) | ${RESUMO} |`, `| [b.md](b.md#topo) | ${RESUMO} |`);
    expect(auditarIndices(dir(idx, ['a.md', 'b.md']))).toHaveLength(0);
  });

  // Citar outro doc DENTRO do resumo com texto amigável é prosa legítima — e é o que o índice real
  // faz hoje (`[faxina knip](faxina-knip-2026-07-07.md)` no resumo de `prs-parados-2026-08-06.md`).
  it('a regra vale só para a 1ª coluna: texto amigável DENTRO do resumo não é acusado', () => {
    const citando = `os 2 PRs dormiram 3 semanas; um deles é a [faxina knip](faxina-knip.md)`;
    const idx = indice(linha('prs-parados.md', citando), linha('faxina-knip.md'));
    expect(auditarIndices(dir(idx, ['prs-parados.md', 'faxina-knip.md']))).toHaveLength(0);
  });
});

describe('auditarIndices — invariante 5: RESUMO REAL, não entrada-fantasma', () => {
  it('FALHA com resumo curto demais para indexar coisa alguma', () => {
    const a = auditarIndices(dir(indice(linha('pcp.md', 'TODO')), ['pcp.md']));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain(`mínimo ${RESUMO_MIN_CHARS}`);
  });

  it('FALHA com célula vazia', () => {
    const a = auditarIndices(dir(indice('| [pcp.md](pcp.md) |  |'), ['pcp.md']));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain('0 chars');
  });

  it('passa no piso quando o resumo é honesto', () => {
    expect(auditarIndices(dir(indice(linha('pcp.md')), ['pcp.md']))).toHaveLength(0);
  });
});

describe('auditarIndices — vários diretórios', () => {
  it('audita cada diretório contra o PRÓPRIO índice, sem vazar entre eles', () => {
    const a = auditarIndices([
      { dir: 'docs/historico', readme: indice(linha('a.md')), arquivos: ['a.md'] },
      { dir: 'docs/runbooks', readme: indice(linha('a.md')), arquivos: ['a.md', 'b.md'] },
    ]);
    expect(a).toHaveLength(1);
    expect(a[0].dir).toBe('docs/runbooks');
    expect(a[0].arquivo).toBe('b.md');
  });
});

describe('lerDiretoriosIndexados — descoberta', () => {
  // Ter README É a declaração de "aqui há índice"; sem README o diretório não promete nada.
  it('só devolve diretório de docs/ que TEM README.md', () => {
    const dirs = lerDiretoriosIndexados();
    for (const d of dirs) expect(d.dir).toMatch(/^docs\//);
    const nomes = dirs.map((d) => d.dir);
    expect(nomes).toContain('docs/historico');
    expect(nomes).toContain('docs/runbooks');
    // docs/agent NÃO entra: quem o indexa é a tabela do CLAUDE.md, e ela enumera DOMÍNIOS —
    // review.md/threat-model-template.md/csv-governo-br.md são sub-docs alcançáveis a um salto.
    expect(nomes).not.toContain('docs/agent');
  });

  it('raiz inexistente devolve lista vazia em vez de estourar', () => {
    expect(lerDiretoriosIndexados('nao-existe-xyz')).toEqual([]);
  });
});

describe('o repo de verdade', () => {
  it('os índices REAIS do repo passam no gate', () => {
    const achados = auditarIndices(lerDiretoriosIndexados());
    expect(achados, `gate vermelho no repo: ${msgs(achados)}`).toHaveLength(0);
  });

  // ⚠️ Guarda ANTI-VÁCUO. Sem ela, um glob que para de casar (ou um `docs/` renomeado) faz o gate
  // acima passar por não achar NADA — "verde por ausência de dado", a mesma família do "glob de
  // teste que não casa nada sai 0 e parece verde" já registrado em ci-testes-edge-deno.md.
  it('o gate de fato ENCONTRA os índices (não passa à toa, sem achar ocorrência nenhuma)', () => {
    const dirs = lerDiretoriosIndexados();
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    const total = dirs.reduce((n, d) => n + d.arquivos.length, 0);
    expect(total).toBeGreaterThanOrEqual(20);
  });

  // A mesma guarda no eixo das ENTRADAS: um parse quebrado que devolvesse [] zeraria as invariantes
  // 3/4/5 em silêncio e ainda assim deixaria o gate verde no eixo do órfão.
  it('cada índice real tem exatamente uma entrada por doc do diretório', () => {
    for (const d of lerDiretoriosIndexados()) {
      const hrefs = parseEntradas(d.readme).map((e) => e.arquivo).sort();
      expect(hrefs, `entradas de ${d.dir}/README.md`).toEqual([...d.arquivos].sort());
    }
  });

  // O piso só é honesto se folgar sobre o índice real; se a menor célula viva encostar nele, é
  // sinal de que o piso passou a cobrar estilo em vez de barrar entrada-fantasma.
  it('o piso de resumo folga sobre a menor célula real do índice', () => {
    const tamanhos = lerDiretoriosIndexados().flatMap((d) =>
      parseEntradas(d.readme).map((e) => e.resumo.length),
    );
    expect(Math.min(...tamanhos)).toBeGreaterThan(RESUMO_MIN_CHARS);
  });
});
