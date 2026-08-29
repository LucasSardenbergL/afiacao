import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  apenasAncoradas,
  auditarCitacoes,
  CONGELADOS,
  contarCitacoesEm,
  formatarResumo,
  lerDocsForaDoEscopo,
  lerDocsVivos,
  parseCitacoes,
  type Citacao,
} from './docs-citacoes-gate-check';

const RAIZ = '/repo';
const DOC = 'docs/agent/exemplo.md';

/** Leitor injetado: o auditor não toca disco, então o "repo" é este Map. */
const repo = (arquivos: Record<string, string>) => (p: string) => arquivos[p] ?? null;

/** Repo de mentira em disco: quem anda em diretório de verdade precisa de diretório de verdade. */
const fixtures: string[] = [];
const fixture = (arquivos: Record<string, string>) => {
  const raiz = mkdtempSync(join(tmpdir(), 'citacoes-gate-'));
  fixtures.push(raiz);
  for (const [rel, texto] of Object.entries(arquivos)) {
    mkdirSync(dirname(join(raiz, rel)), { recursive: true });
    writeFileSync(join(raiz, rel), texto);
  }
  return raiz;
};
afterAll(() => {
  for (const f of fixtures) rmSync(f, { recursive: true, force: true });
});

const cita = (alvo: string, linhas: string[], ancora: string | null): Citacao => ({
  doc: DOC,
  linhaDoDoc: 1,
  alvo,
  linhas,
  ancora,
});

const msgs = (r: { achados: { msg: string }[] }) => r.achados.map((a) => a.msg).join(' | ');

describe('parseCitacoes — o que conta como citação', () => {
  it('captura caminho, linha e âncora', () => {
    const [c] = parseCitacoes(DOC, 'veja `src/a.ts:12`<!--cita: const x-->').citacoes;
    expect(c).toMatchObject({ alvo: 'src/a.ts', linhas: ['12'], ancora: 'const x' });
  });

  it('âncora ausente vira null (e não string vazia)', () => {
    const [c] = parseCitacoes(DOC, 'veja `src/a.ts:12` e mais nada').citacoes;
    expect(c.ancora).toBeNull();
  });

  it('tolera espaço e parêntese ao redor da âncora', () => {
    const [c] = parseCitacoes(DOC, '(`src/a.ts:12`<!--   cita:   const x   -->)').citacoes;
    expect(c.ancora).toBe('const x');
  });

  it('captura a forma multi-linha para o auditor poder recusá-la', () => {
    const [c] = parseCitacoes(DOC, '`a.md:133,416`').citacoes;
    expect(c.linhas).toEqual(['133', '416']);
  });

  it('link markdown comum NÃO é citação (não tem :linha)', () => {
    expect(parseCitacoes(DOC, '[roadmap](../ux-audit/03-roadmap.md)').citacoes).toHaveLength(0);
  });

  it('registra a linha do DOC, para a mensagem apontar onde consertar', () => {
    const [c] = parseCitacoes(DOC, 'linha1\nlinha2\n`src/a.ts:9`<!--cita: z-->').citacoes;
    expect(c.linhaDoDoc).toBe(3);
  });
});

describe('parseCitacoes — âncora que quebrou de linha ainda é âncora', () => {
  it('adota a âncora da linha SEGUINTE — a varredura é linha a linha e o `\\s*` nunca vê o `\\n`', () => {
    const [c] = parseCitacoes(DOC, 'como diz `src/a.ts:12`\n<!--cita: const x--> — e segue o texto')
      .citacoes;
    expect(c).toMatchObject({ alvo: 'src/a.ts', linhas: ['12'], ancora: 'const x' });
  });

  it('a citação continua com a linha DELA, não a da âncora', () => {
    const [c] = parseCitacoes(DOC, 'topo\nveja `src/a.ts:12`\n<!--cita: const x-->').citacoes;
    expect(c.linhaDoDoc).toBe(2);
  });

  it('NÃO adota se sobrou texto depois da citação — a âncora abaixo não é dela', () => {
    const [c] = parseCitacoes(DOC, 'veja `src/a.ts:12` e pare aqui\n<!--cita: const x-->').citacoes;
    expect(c.ancora).toBeNull();
  });

  it('com DUAS citações na linha, só a última adota — senão a âncora vira de quem não é dona', () => {
    const cs = parseCitacoes(DOC, '`src/a.ts:1` e `src/b.ts:2`\n<!--cita: const x-->').citacoes;
    expect(cs.map((c) => c.ancora)).toEqual([null, 'const x']);
  });

  it('linha seguinte que não é âncora não vira âncora', () => {
    const [c] = parseCitacoes(DOC, 'veja `src/a.ts:12`\nparágrafo comum').citacoes;
    expect(c.ancora).toBeNull();
  });

  it('citação na ÚLTIMA linha do arquivo não estoura ao espiar a próxima', () => {
    expect(() => parseCitacoes(DOC, 'veja `src/a.ts:12`')).not.toThrow();
    expect(parseCitacoes(DOC, 'veja `src/a.ts:12`').citacoes[0].ancora).toBeNull();
  });
});

describe('apenasAncoradas — a promessa que o autor escreveu à mão', () => {
  it('fica só com quem tem âncora', () => {
    const cs = [cita('src/a.ts', ['1'], 'x'), cita('src/b.ts', ['2'], null)];
    expect(apenasAncoradas(cs).map((c) => c.alvo)).toEqual(['src/a.ts']);
  });

  it('âncora VAZIA continua sendo âncora — quem recusa é o auditor, não o filtro', () => {
    expect(apenasAncoradas([cita('src/a.ts', ['1'], '')])).toHaveLength(1);
  });
});

describe('parseCitacoes — bloco de código é exemplo, não citação', () => {
  it('PULA citação dentro de cerca ``` — ali ela ilustra o formato, não afirma nada sobre o repo', () => {
    const { citacoes } = parseCitacoes(
      DOC,
      'antes\n```\n`src/a.ts:12`<!--cita: nunca existiu-->\n```\ndepois',
    );
    expect(citacoes).toHaveLength(0);
  });

  it('PULA dentro de ~~~ também, e ``` não fecha um bloco aberto com ~~~', () => {
    const { citacoes } = parseCitacoes(DOC, '~~~\n```\n`src/a.ts:12`<!--cita: x-->\n~~~');
    expect(citacoes).toHaveLength(0);
  });

  // SENTINELA de cegueira. A citação canônica deste repo NASCE entre crases, então o stripper
  // tem de ser `removerCercas` e nunca `removerCodigo`: medido em 2026-08-22, trocar um pelo
  // outro leva as 22 citações vivas a 0 e o gate fica verde sem ter olhado NADA. Este teste é o
  // que fica vermelho quando alguém faz essa troca "de limpeza".
  it('NÃO pula citação entre crases inline — é a forma CANÔNICA, não um exemplo', () => {
    const { citacoes } = parseCitacoes(DOC, 'veja `src/a.ts:12`<!--cita: const x--> aqui');
    expect(citacoes).toHaveLength(1);
  });

  it('volta a cobrar depois da cerca fechar, com a numeração de linha intacta', () => {
    const { citacoes } = parseCitacoes(DOC, '```\nexemplo\n```\n`src/a.ts:9`<!--cita: z-->');
    expect(citacoes).toHaveLength(1);
    expect(citacoes[0].linhaDoDoc).toBe(4);
  });

  // O skip abre um modo de falha NOVO: uma cerca que nunca fecha apaga todas as citações abaixo
  // dela. Descartar isso em silêncio é a cegueira de `gates-textuais-cegos.md` — então vira achado.
  it('cerca ABERTA que engole citação vira achado, apontando a linha da abertura', () => {
    const { citacoes, achados } = parseCitacoes(DOC, 'a\n```ts\n`src/a.ts:12`<!--cita: x-->');
    expect(citacoes).toHaveLength(0);
    expect(achados).toHaveLength(1);
    expect(achados[0].linhaDoDoc).toBe(2);
    expect(achados[0].msg).toContain('nunca fechada');
  });

  // Cerca aberta que não escondeu citação nenhuma não cega nada — reprovar aí seria cobrar estilo
  // de markdown, que não é o assunto deste gate.
  it('cerca aberta que NÃO engole citação não vira achado', () => {
    const { achados } = parseCitacoes(DOC, 'a\n```ts\nconst x = 1;');
    expect(achados).toHaveLength(0);
  });
});

describe('auditarCitacoes — a regressão que este gate existe para pegar', () => {
  const idx = new Map<string, string[]>();

  it('passa quando a linha citada realmente contém a âncora', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['2'], 'Carbon Touch Target')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'linha1\nCarbon Touch Target spec\nlinha3' }),
    );
    expect(r.achados).toHaveLength(0);
    expect(r.verificadas).toBe(1);
  });

  // O caso real: o #1813 inseriu 2 linhas no topo de um doc citado e as 5 citações do #1803
  // passaram a apontar para `**ICE**: ...`. A linha CONTINUAVA existindo — só o conteúdo mudou.
  it('REPROVA quando o conteúdo desloca, mesmo a linha continuando a existir', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['2'], 'Carbon Touch Target')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'nova\nlinha1\nCarbon Touch Target spec' }),
    );
    expect(r.achados).toHaveLength(1);
    expect(msgs(r)).toContain('deveria conter');
    expect(msgs(r)).toContain('linha1'); // mostra o que está lá HOJE, para o conserto ser óbvio
  });

  it('REPROVA citação sem âncora — número de linha sozinho é inverificável', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['1'], null)],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'qualquer coisa' }),
    );
    expect(msgs(r)).toContain('não tem âncora');
  });

  it('REPROVA âncora vazia (não deixa burlar com `<!--cita:-->`)', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['1'], '')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'qualquer coisa' }),
    );
    expect(msgs(r)).toContain('âncora VAZIA');
  });

  it('REPROVA linha fora do arquivo', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['99'], 'x')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'uma linha só' }),
    );
    expect(msgs(r)).toContain('FORA do arquivo');
  });

  it('REPROVA arquivo citado que não existe', () => {
    const r = auditarCitacoes([cita('src/sumiu.ts', ['1'], 'x')], RAIZ, idx, repo({}));
    expect(msgs(r)).toContain('NÃO existe no repo');
  });

  it('REPROVA a forma `:133,416` — uma âncora só descreve UMA linha', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['1', '2'], 'x')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'a\nb' }),
    );
    expect(msgs(r)).toContain('várias linhas de uma vez');
  });

  it('resolve basename ÚNICO no repo (citação sem barra ainda é verificada)', () => {
    const r = auditarCitacoes(
      [cita('unico.ts', ['1'], 'achei')],
      RAIZ,
      new Map([['unico.ts', ['/repo/src/fundo/unico.ts']]]),
      repo({ '/repo/src/fundo/unico.ts': 'achei aqui' }),
    );
    expect(r.achados).toHaveLength(0);
    expect(r.verificadas).toBe(1);
  });

  // Adivinhar QUAL `index.ts` seria falso-positivo; PULAR seria a saída de emergência que
  // esvazia o gate (bastaria escrever o nome curto). Então reprova e diz o que fazer.
  it('REPROVA basename ambíguo, sugerindo o caminho completo', () => {
    const r = auditarCitacoes(
      [cita('index.ts', ['1'], 'x')],
      RAIZ,
      new Map([['index.ts', ['/repo/a/index.ts', '/repo/b/index.ts']]]),
      repo({}),
    );
    expect(msgs(r)).toContain('basename ambíguo');
    expect(msgs(r)).toContain('casa com 2 arquivos');
    expect(msgs(r)).toContain('a/index.ts'); // sugere um caminho concreto para o conserto
  });

  it('REPROVA basename que não casa com arquivo NENHUM', () => {
    const r = auditarCitacoes([cita('sumiu.ts', ['1'], 'x')], RAIZ, new Map(), repo({}));
    expect(msgs(r)).toContain('NÃO existe no repo');
  });

  it('PULA caminho externo declarado em EXTERNOS', () => {
    const r = auditarCitacoes(
      [cita('postgrest-js/src/PostgrestBuilder.ts', ['185'], null)],
      RAIZ,
      idx,
      repo({}),
    );
    expect(r.achados).toHaveLength(0);
    expect(r.externas).toBe(1);
  });

  it('resolve relativo ao DOC antes da raiz (link markdown `../` funciona)', () => {
    const r = auditarCitacoes(
      [cita('../ux-audit/03-roadmap.md', ['1'], 'ICE')],
      RAIZ,
      idx,
      repo({ '/repo/docs/ux-audit/03-roadmap.md': 'ICE = Impact × Confidence × Ease' }),
    );
    expect(r.achados).toHaveLength(0);
  });
});

describe('lerDocsVivos — escopo', () => {
  const vivos = lerDocsVivos('.');

  it('varre os docs vivos (agent/visual-direction/runbooks)', () => {
    expect(vivos).toContain('docs/agent/mapa-do-app.md');
    expect(vivos).toContain('docs/visual-direction/01-direcao.md');
  });

  it('NÃO varre artefato datado listado em CONGELADOS', () => {
    for (const c of CONGELADOS) expect(vivos).not.toContain(c);
  });

  // Um spec de maio cita o código de maio e está CERTO ao fazer isso.
  it('NÃO varre docs congelados por diretório (historico/superpowers/ux-audit)', () => {
    expect(vivos.some((v) => v.startsWith('docs/historico/'))).toBe(false);
    expect(vivos.some((v) => v.startsWith('docs/superpowers/'))).toBe(false);
    expect(vivos.some((v) => v.startsWith('docs/ux-audit/'))).toBe(false);
  });
});

describe('parseCitacoes — o que foi PULADO também é relato', () => {
  // "21 citações verificadas ✓" lê como cobertura TOTAL tanto quando o gate cobriu tudo quanto
  // quando deixou centenas de fora. Corte deliberado que não aparece no log é indistinguível de
  // cobertura completa para quem lê o CI — é o "no silent caps" da skill `matar-classe`.
  it('conta a citação pulada por cerca em vez de sumir com ela', () => {
    const p = parseCitacoes(DOC, 'antes\n```\n`src/a.ts:12`<!--cita: exemplo-->\n```\ndepois');
    expect(p.citacoes).toHaveLength(0);
    expect(p.emCerca).toBe(1);
  });

  // Calibração inversa: sem ela, um contador que devolve sempre "tem pulo" passaria igual.
  it('não inventa pulo onde não houve — citação inline conta 0 em cerca', () => {
    const p = parseCitacoes(DOC, 'veja `src/a.ts:12`<!--cita: const x--> aqui');
    expect(p.citacoes).toHaveLength(1);
    expect(p.emCerca).toBe(0);
  });

  it('a citação engolida por cerca ABERTA também entra na conta de pulos', () => {
    const p = parseCitacoes(DOC, 'a\n```ts\n`src/a.ts:12`<!--cita: x-->');
    expect(p.citacoes).toHaveLength(0);
    expect(p.emCerca).toBe(1);
  });
});

describe('escondidas — o que a cerca ABERTA engoliu, para o chamador decidir', () => {
  it('devolve a citação engolida, e não só o número', () => {
    const r = parseCitacoes(DOC, 'antes\n```\nveja `src/a.ts:9`<!--cita: z-->');
    expect(r.escondidas.map((c) => c.alvo)).toEqual(['src/a.ts']);
    expect(apenasAncoradas(r.escondidas)).toHaveLength(1);
  });

  it('cerca fechada não esconde nada', () => {
    expect(parseCitacoes(DOC, '```\nveja `src/a.ts:9`\n```').escondidas).toEqual([]);
  });
});

describe('fora do escopo — o gate diz o que NÃO olhou', () => {
  it('lista o doc congelado por diretório, que o varredor de vivos nunca vê', () => {
    const raiz = fixture({
      'docs/agent/vivo.md': 'vivo',
      'docs/historico/datado.md': 'datado',
      'docs/superpowers/specs/plano.md': 'spec',
    });
    const fora = lerDocsForaDoEscopo(raiz);
    expect(fora).toContain('docs/historico/datado.md');
    expect(fora).toContain('docs/superpowers/specs/plano.md');
    expect(fora).not.toContain('docs/agent/vivo.md');
  });

  // Calibração inversa OBRIGATÓRIA: sem este caso, um contador travado em 0 passaria no de cima
  // (que só exige "≥ 1 fora") e o relato voltaria a mentir cobertura total.
  it('reporta ZERO quando o repo não tem doc nenhum fora do escopo', () => {
    expect(lerDocsForaDoEscopo(fixture({ 'docs/agent/vivo.md': 'só vivo aqui' }))).toEqual([]);
  });

  // Artefato datado que mora DENTRO de pasta viva sai pelo nome — e sair do escopo é sair do
  // escopo: ele conta como pulo igual ao congelado por diretório.
  it('o arquivo nominal de CONGELADOS também conta como fora do escopo', () => {
    const raiz = fixture({ [CONGELADOS[0]]: 'revisão fechada', 'docs/agent/vivo.md': 'vivo' });
    expect(lerDocsForaDoEscopo(raiz)).toEqual([CONGELADOS[0]]);
  });

  // O caso que mordeu em 2026-08-25: um doc que ENSINA sobre gate cego, citando quatro PRs, mora
  // na zona não varrida. Ninguém verificava as citações dele, e o log não dizia isso.
  it('o doc real que motivou o relato aparece como fora do escopo', () => {
    expect(lerDocsForaDoEscopo('.')).toContain('docs/historico/verificar-sonda-versao.md');
  });

  it('conta as citações que moram nos docs não varridos', () => {
    const n = contarCitacoesEm(['a.md', 'b.md'], (d) =>
      d === 'a.md' ? '`src/x.ts:1`<!--cita: z--> e `src/y.ts:2`<!--cita: w-->' : '`src/k.ts:3`',
    );
    expect(n).toBe(3);
  });

  // Segunda calibração inversa, agora do contador de citações.
  it('conta zero quando o doc fora do escopo não cita nada', () => {
    expect(contarCitacoesEm(['a.md'], () => 'prosa sem citação nenhuma')).toBe(0);
  });

  // No congelado ninguém verifica NADA — nem o que está entre crases, nem o que está em cerca.
  it('no doc não varrido a citação em cerca conta como pulo igual', () => {
    expect(contarCitacoesEm(['a.md'], () => '```\n`src/x.ts:1`<!--cita: z-->\n```')).toBe(1);
  });

  it('o resumo nomeia quantos pulos houve e por QUAL motivo', () => {
    const s = formatarResumo({ achados: [], verificadas: 21, externas: 2 }, {
      emDocNaoVarrido: 553,
      emCerca: 6,
    });
    expect(s).toContain('21 citação(ões) verificada(s)');
    expect(s).toContain('2 externa(s)');
    expect(s).toContain('559 fora do escopo');
    expect(s).toContain('553 em doc não varrido');
    expect(s).toContain('6 em cerca');
    expect(s).not.toContain('\n'); // uma linha só — é log de CI, não relatório
  });

  // Terceira calibração inversa: o resumo tem de saber dizer "não pulei nada".
  it('com cobertura total o resumo diz 0 fora do escopo, em vez de omitir a cláusula', () => {
    const s = formatarResumo({ achados: [], verificadas: 3, externas: 0 }, {
      emDocNaoVarrido: 0,
      emCerca: 0,
    });
    expect(s).toContain('0 fora do escopo');
  });
});
