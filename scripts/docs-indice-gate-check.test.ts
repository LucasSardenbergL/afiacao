import { describe, expect, it } from 'vitest';
import {
  auditarIndices,
  type DirIndice,
  lerDiretoriosIndexados,
  linksDoIndice,
} from './docs-indice-gate-check';

/** Índice mínimo no formato real (tabela de duas colunas com link relativo). */
function indice(...linhas: string[]): string {
  return `# docs/x/ — diário\n\n| Arquivo | O que tem |\n| --- | --- |\n${linhas.join('\n')}\n`;
}
const linha = (f: string) => `| [${f}](${f}) | descrição |`;

const dir = (readme: string, arquivos: string[]): DirIndice[] => [
  { dir: 'docs/x', readme, arquivos },
];

const msgs = (a: ReturnType<typeof auditarIndices>) => a.map((f) => f.msg).join(' | ');

describe('auditarIndices — invariante 1: arquivo ÓRFÃO (o bug do #1659)', () => {
  it('passa quando todo arquivo está no índice', () => {
    expect(auditarIndices(dir(indice(linha('a.md'), linha('b.md')), ['a.md', 'b.md']))).toHaveLength(0);
  });

  it('FALHA com um arquivo fora do índice — a forma exata do #1659', () => {
    const a = auditarIndices(dir(indice(linha('a.md')), ['a.md', 'programa-cabreuva-colacor.md']));
    expect(a).toHaveLength(1);
    expect(a[0].arquivo).toBe('programa-cabreuva-colacor.md');
    expect(a[0].level).toBe('error');
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
  it('a mensagem explica que o doc fica INVISÍVEL e diz onde consertar', () => {
    const a = auditarIndices(dir(indice(linha('a.md')), ['a.md', 'novo.md']));
    expect(a[0].msg).toContain('invisível');
    expect(a[0].msg).toContain('docs/x/README.md');
  });
});

describe('auditarIndices — invariante 2: LINK QUEBRADO (a direção oposta)', () => {
  it('FALHA quando o índice aponta para arquivo que não existe', () => {
    const a = auditarIndices(dir(indice(linha('a.md'), linha('sumiu.md')), ['a.md']));
    expect(a).toHaveLength(1);
    expect(a[0].arquivo).toBe('sumiu.md');
    expect(a[0].msg).toContain('NÃO existe');
  });

  it('renomeação pela metade acusa NOS DOIS lados (órfão + link quebrado)', () => {
    const a = auditarIndices(dir(indice(linha('nome-velho.md')), ['nome-novo.md']));
    expect(a).toHaveLength(2);
    expect(msgs(a)).toContain('nome-novo.md');
    expect(msgs(a)).toContain('nome-velho.md');
  });
});

describe('linksDoIndice — o que conta como "indexado"', () => {
  it('aceita `](x.md)` e `](./x.md)`', () => {
    expect(linksDoIndice('[a](a.md) [b](./b.md)')).toEqual(new Set(['a.md', 'b.md']));
  });

  // Linkar a seção certa de um doc longo é uso normal de markdown; sem a âncora opcional o gate
  // acusaria "órfão" um arquivo que ESTÁ indexado — o falso-positivo mais provável desta regra.
  it('aceita âncora: `](x.md#secao)` indexa x.md', () => {
    expect(linksDoIndice('[a](a.md#o-achado) [b](./b.md#fases)')).toEqual(new Set(['a.md', 'b.md']));
  });

  it('arquivo com âncora não vira órfão', () => {
    expect(auditarIndices(dir(indice('| [a](a.md#topo) | d |'), ['a.md']))).toHaveLength(0);
  });

  // Link para FORA do diretório não indexa o arquivo local: o índice de um diretório só responde
  // pelos arquivos dele, e casar `../agent/x.md` como `x.md` daria indexação fantasma.
  it('IGNORA link para outro diretório e para a web', () => {
    const s = linksDoIndice('[a](../agent/a.md) [b](https://ex.com/b.md) [c](docs/historico/c.md)');
    expect(s.size).toBe(0);
  });

  it('README sem link nenhum não indexa nada (não vira passe-livre)', () => {
    expect(linksDoIndice('# só prosa, zero tabela').size).toBe(0);
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
});
