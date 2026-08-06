import { describe, it, expect } from 'vitest';
import {
  auditarIndice,
  parseEntradas,
  lerHistorico,
  RESUMO_MIN_CHARS,
  type Achado,
} from './historico-indice-gate-check';

const RESUMO = 'entrega do PR #1234 — 3 bugs, 2 lições e o número que provou';

const linha = (doc: string, resumo = RESUMO) => `| [${doc}](${doc}) | ${resumo} |`;

/** README completo (cabeçalho + tabela + rodapé), como o real. */
function readme(...linhas: string[]): string {
  return `# docs/historico/ — diário de PR / entregas

Venha aqui quando precisar do detalhe/contexto de uma entrega.

| Arquivo | O que tem |
| --- | --- |
${linhas.join('\n')}

> **As 3 camadas do refactor:** lição durável → \`docs/agent/<dominio>.md\`; narrativa → aqui.
`;
}

const msgs = (a: Achado[]) => a.map((f) => f.msg).join(' | ');

describe('parseEntradas — o que conta como entrada do índice', () => {
  it('lê uma linha de dados normal', () => {
    const e = parseEntradas(readme(linha('pcp.md')));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ href: 'pcp.md', texto: 'pcp.md', resumo: RESUMO });
  });

  it('ignora cabeçalho e separador (`| Arquivo |`, `| --- |`)', () => {
    expect(parseEntradas(readme())).toHaveLength(0);
  });

  // O discriminante do gate. Uma busca solta por "(nome.md)" no arquivo inteiro — que é como se
  // verifica isso à mão — daria `setup-agente.md` por LISTADO só porque outro resumo o cita.
  it('link CITADO no resumo de outra entrada NÃO conta como entrada própria', () => {
    const citando = `diagnóstico das 240 sessões; execução em [setup-agente.md](setup-agente.md)`;
    const e = parseEntradas(readme(linha('melhorias-code-2026-07.md', citando)));
    expect(e.map((x) => x.href)).toEqual(['melhorias-code-2026-07.md']);
  });

  it('link em PROSA (fora da tabela) não conta', () => {
    const texto = `# t\n\nveja [pcp.md](pcp.md) para o detalhe.\n\n| Arquivo | O que tem |\n| --- | --- |\n`;
    expect(parseEntradas(texto)).toHaveLength(0);
  });

  it('`|` dentro do resumo (código inline) não quebra o parse nem trunca o resumo', () => {
    const r = 'o pipe `cmd | tail` engole o exit code — medido em 3 sessões';
    const e = parseEntradas(readme(linha('worktrees.md', r)));
    expect(e).toHaveLength(1);
    expect(e[0].resumo).toBe(r);
  });

  it('reporta a LINHA da entrada (clicável no editor)', () => {
    const e = parseEntradas(readme(linha('a.md'), linha('b.md')));
    expect(e[1].line).toBe(e[0].line + 1);
  });
});

describe('invariante 1 — doc órfão (o buraco dos #1658 e #1665)', () => {
  it('passa quando todo doc tem entrada', () => {
    expect(auditarIndice(['pcp.md', 'modularizacao.md'], readme(linha('pcp.md'), linha('modularizacao.md')))).toHaveLength(0);
  });

  it('FALHA com doc no diretório e ausente do índice', () => {
    const a = auditarIndice(['pcp.md', 'piso-de-contexto.md'], readme(linha('pcp.md')));
    expect(a).toHaveLength(1);
    expect(a[0].level).toBe('error');
    expect(a[0].msg).toContain('piso-de-contexto.md');
    expect(a[0].msg).toContain('invisível');
  });

  it('a mensagem entrega a linha PRONTA para colar', () => {
    const a = auditarIndice(['pcp.md'], readme());
    expect(a[0].msg).toContain('| [pcp.md](pcp.md) |');
  });

  // O estado exato que o #1658 encontrou: metade do histórico recente fora do índice.
  it('acusa TODOS os órfãos de uma vez, não só o primeiro', () => {
    const docs = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md', 'z.md'];
    const a = auditarIndice(docs, readme(linha('z.md')));
    expect(a).toHaveLength(9);
    expect(a.map((f) => f.msg.match(/`([a-z.-]+\.md)`/)![1])).toEqual(docs.slice(0, 9));
  });

  it('README.md não é cobrado de entrada própria', () => {
    expect(auditarIndice([], readme())).toHaveLength(0);
  });

  // A asserção que separa este gate da verificação à mão. `grep "(setup-agente.md)"` no README
  // inteiro devolve HIT — o nome aparece, citado dentro do resumo de OUTRA entrada — e conclui
  // "listado". O doc segue sem linha própria, invisível no índice. Aqui tem que dar órfão.
  it('doc apenas CITADO no resumo alheio continua órfão (o falso-negativo da busca solta)', () => {
    const citando = `diagnóstico das 240 sessões; execução em [setup-agente.md](setup-agente.md)`;
    const idx = readme(linha('melhorias-code-2026-07.md', citando));

    expect(idx).toContain('(setup-agente.md)'); // a busca solta acharia e daria por listado

    const a = auditarIndice(['melhorias-code-2026-07.md', 'setup-agente.md'], idx);
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain('setup-agente.md');
    expect(a[0].msg).toContain('invisível');
  });
});

describe('invariante 2 — entrada morta (doc renomeado/removido)', () => {
  it('FALHA quando a entrada aponta para arquivo inexistente', () => {
    const a = auditarIndice([], readme(linha('sumiu.md')));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain('link morto');
    expect(a[0].line).toBeGreaterThan(0);
  });

  it('renomear o doc sem mexer no índice dá os DOIS erros (órfão novo + link morto)', () => {
    const a = auditarIndice(['novo-nome.md'], readme(linha('nome-antigo.md')));
    expect(a).toHaveLength(2);
    expect(msgs(a)).toContain('novo-nome.md');
    expect(msgs(a)).toContain('nome-antigo.md');
  });
});

describe('invariante 3 — duplicata (append de duas worktrees paralelas)', () => {
  it('FALHA com o mesmo doc em duas linhas — o git aceita o merge das duas', () => {
    const a = auditarIndice(['pcp.md'], readme(linha('pcp.md'), linha('pcp.md', 'outro resumo, escrito noutra sessão')));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain('2 entradas');
  });
});

describe('invariante 4 — texto do link = destino', () => {
  it('FALHA com `[a.md](b.md)` (copiar-colar de outra linha)', () => {
    const a = auditarIndice(['b.md'], readme(`| [a.md](b.md) | ${RESUMO} |`));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain('diverge do destino');
  });
});

describe('invariante 5 — resumo real, não entrada-fantasma', () => {
  it('FALHA com resumo curto demais para indexar coisa alguma', () => {
    const a = auditarIndice(['pcp.md'], readme(linha('pcp.md', 'TODO')));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain(`mínimo ${RESUMO_MIN_CHARS}`);
  });

  it('FALHA com célula vazia', () => {
    const a = auditarIndice(['pcp.md'], readme('| [pcp.md](pcp.md) |  |'));
    expect(a).toHaveLength(1);
    expect(a[0].msg).toContain('0 chars');
  });

  it('passa no piso quando o resumo é honesto', () => {
    expect(auditarIndice(['pcp.md'], readme(linha('pcp.md')))).toHaveLength(0);
  });
});

describe('o repo de verdade', () => {
  it('o índice REAL de docs/historico/ passa no gate', () => {
    const { docs, readme: real } = lerHistorico();
    const a = auditarIndice(docs, real);
    expect(a, `gate vermelho no repo:\n${a.map((f) => `  ${f.file}:${f.line} ${f.msg}`).join('\n')}`).toHaveLength(0);
  });

  // Sem isto, um parse quebrado que devolvesse [] deixaria o gate "verde" no eixo das entradas.
  it('o índice de fato tem entradas, uma por doc (o gate não passa à toa)', () => {
    const { docs, readme: real } = lerHistorico();
    const entradas = parseEntradas(real);
    expect(docs.length).toBeGreaterThan(20);
    expect(entradas.map((e) => e.href).sort()).toEqual([...docs].sort());
  });
});
