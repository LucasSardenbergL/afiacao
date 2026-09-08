import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Estado, Veredito } from './pendencias-deploy';
import {
  blocoDeConferencia,
  conferirCobertura,
  type EdgeParaDeploy,
  ESTADOS_DE_DEPLOY,
  MARCAS_DE_CONFERENCIA,
  montarPrompt,
  numeral,
  type Procedencia,
  selecionarParaDeploy,
} from './prompt-deploy';

const MAPA = 'supabase/functions/_shared/sonda-fingerprints.ts';

/** Procedência bem-formada — o gerador recusa hash sem dizer de que commit ele é. */
const PROC: Procedencia = { ref: 'origin/main', sha: '84a115a43' };

/**
 * Hash de MENTIRA, mas bem-formado e distinto por caminho. Distinto importa: hash igual em todos
 * os arquivos deixaria o check de cobertura verde mesmo trocando o hash de um arquivo pelo do
 * outro, e aí ele não estaria medindo nada.
 */
function hashDe(caminho: string): string {
  return createHash('sha256').update(caminho).digest('hex');
}

function veredito(edge: string, estado: Estado): Veredito {
  return {
    edge,
    estado,
    esperado: 'abc123',
    observado: estado === 'NUNCA_ATESTADA' ? null : 'def456',
    versaoEsperada: 'v2',
    versao: 'v1',
    via: 'sonda',
    criado: '2026-09-07 12:00:00+00',
    idadeHoras: 3,
    diasPendente: 1,
    escalada: false,
  };
}

/** Fatia bem-formada: o index, um `_shared` importado, o marcador de versão e o MAPA. */
function fatia(edge: string): EdgeParaDeploy {
  return {
    edge,
    arquivos: [
      `supabase/functions/${edge}/index.ts`,
      `supabase/functions/${edge}/versao.ts`,
      'supabase/functions/_shared/sonda-versao.ts',
      MAPA,
    ].map((caminho) => ({ caminho, sha256: hashDe(caminho) })),
  };
}

describe('ESTADOS_DE_DEPLOY — o conjunto é a decisão de produto, não detalhe', () => {
  it('é EXATAMENTE a divergência medida: nem mais, nem menos', () => {
    // Fixado de propósito. Acrescentar `NUNCA_ATESTADA` aqui faria o gerador pedir deploy de edge
    // cujo estado ANTES é desconhecido — ausência de dado virando ordem de deploy, que é o gasto
    // redundante que o ledger existe para evitar. Quem mudar este conjunto quebra este teste e
    // tem de justificar no PR.
    expect([...ESTADOS_DE_DEPLOY].sort()).toEqual([
      'DIVERGE_P1',
      'DIVERGE_P2',
      'INCOERENTE',
      'SEM_MAPA_NO_BUNDLE',
    ]);
  });
});

describe('selecionarParaDeploy', () => {
  it('pega os quatro estados de divergência medida', () => {
    const vs = [
      veredito('a', 'DIVERGE_P1'),
      veredito('b', 'DIVERGE_P2'),
      veredito('c', 'INCOERENTE'),
      veredito('d', 'SEM_MAPA_NO_BUNDLE'),
    ];
    expect(selecionarParaDeploy(vs)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('NÃO pede deploy de NUNCA_ATESTADA nem de SEM_FONTE_NO_ECO — é ausência de dado, pede SONDA', () => {
    const vs = [veredito('nunca', 'NUNCA_ATESTADA'), veredito('sem-fonte', 'SEM_FONTE_NO_ECO')];
    expect(selecionarParaDeploy(vs)).toEqual([]);
  });

  it('não pede deploy de CONFERE nem de FORA_DO_MAPA', () => {
    const vs = [veredito('ok', 'CONFERE'), veredito('orfa', 'FORA_DO_MAPA')];
    expect(selecionarParaDeploy(vs)).toEqual([]);
  });

  it('ordena por nome — dois runs sobre o mesmo ledger dão o MESMO prompt', () => {
    const vs = [
      veredito('zulu', 'DIVERGE_P1'),
      veredito('alfa', 'DIVERGE_P1'),
      veredito('mike', 'DIVERGE_P1'),
    ];
    expect(selecionarParaDeploy(vs)).toEqual(['alfa', 'mike', 'zulu']);
  });
});

describe('montarPrompt — 1 edge', () => {
  const prompt = montarPrompt([fatia('minha-edge')], PROC);

  it('nomeia TODOS os arquivos da fatia, não só o index', () => {
    expect(conferirCobertura(prompt, [fatia('minha-edge')])).toEqual({ ok: true, faltando: [] });
  });

  it('carrega as travas que impedem o Lovable de "melhorar" o código', () => {
    expect(prompt).toContain('**verbatim**');
    expect(prompt).toContain('do NOT modify');
    expect(prompt).toContain('**Active**');
  });
});

describe('montarPrompt — leva', () => {
  const edges = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(fatia);
  const prompt = montarPrompt(edges, PROC);

  it('declara o total por extenso e proíbe pular', () => {
    expect(prompt).toContain('**eight**');
    expect(prompt).toContain('Deploy every function listed; do not');
    expect(prompt).toContain('skip any');
  });

  it('numera uma seção por edge, de 1 a N', () => {
    expect(prompt).toContain('**1. `a`**');
    expect(prompt).toContain('**8. `h`**');
  });

  it('fecha pedindo confirmação item a item', () => {
    expect(prompt).toContain('confirm that **each one** shows **Active**');
  });

  it('cobre as 8 fatias inteiras', () => {
    expect(conferirCobertura(prompt, edges).ok).toBe(true);
  });
});

describe('conferirCobertura — o check que segura o modo de falha', () => {
  it('FALSIFICAÇÃO: prompt montado SEM o mapa fica VERMELHO contra a fatia com o mapa', () => {
    // Isto é exatamente o bug de docs/historico/closure-de-hash-nao-e-lista-de-deploy.md:
    // derivar a fatia da `fecharGrafo()` (que exclui o mapa de propósito) e não somar o mapa.
    // O bundle BOOTA e serve FONTE_SHA256 velho — a sonda nasce cega. Se esta asserção ficar
    // verde, o check é decorativo e o gerador não segura nada.
    const semMapa: EdgeParaDeploy = {
      edge: 'minha-edge',
      arquivos: fatia('minha-edge').arquivos.filter((a) => a.caminho !== MAPA),
    };
    const promptCego = montarPrompt([semMapa], PROC);

    const r = conferirCobertura(promptCego, [fatia('minha-edge')]);
    expect(r.ok).toBe(false);
    expect(r.faltando).toEqual([`minha-edge:${MAPA}`]);
  });

  it('CONTROLE: a MESMA fatia, com o mapa, fica verde — senão o vermelho acima não prova nada', () => {
    const completa = fatia('minha-edge');
    expect(conferirCobertura(montarPrompt([completa], PROC), [completa]).ok).toBe(true);
  });

  it('não se deixa enganar por substring — `sonda-versao.ts` ⊄ `sonda-versao_test.ts`', () => {
    const pedido: EdgeParaDeploy = {
      edge: 'x',
      arquivos: [{ caminho: 'supabase/functions/_shared/sonda-versao.ts', sha256: hashDe('a') }],
    };
    const promptErrado: EdgeParaDeploy = {
      edge: 'x',
      arquivos: [
        { caminho: 'supabase/functions/_shared/sonda-versao_test.ts', sha256: hashDe('a') },
      ],
    };
    expect(conferirCobertura(montarPrompt([promptErrado], PROC), [pedido]).ok).toBe(false);
  });

  it('acusa edge inteira ausente do prompt', () => {
    const prompt = montarPrompt([fatia('a')], PROC);
    const r = conferirCobertura(prompt, [fatia('a'), fatia('esquecida')]);
    expect(r.ok).toBe(false);
    expect(r.faltando).toContain('edge:esquecida');
  });
});

describe('recusas', () => {
  it('leva vazia LANÇA — colagem que não deploya nada pareceria trabalho feito', () => {
    expect(() => montarPrompt([], PROC)).toThrow(/leva vazia/);
  });

  it('fatia vazia LANÇA — o closure nunca é vazio, então é falha de leitura', () => {
    expect(() => montarPrompt([{ edge: 'x', arquivos: [] }], PROC)).toThrow(/fatia vazia/);
  });
});

describe('numeral', () => {
  it('escreve por extenso até 12 e cai no dígito acima disso', () => {
    expect(numeral(1)).toBe('one');
    expect(numeral(8)).toBe('eight');
    expect(numeral(12)).toBe('twelve');
    expect(numeral(13)).toBe('13');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// O sha256 por arquivo e o ramo fail-CLOSED
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Por que isto existe: o deploy de edge sai do SANDBOX do Lovable, não de um checkout da `main`, e
// o sandbox pode estar atrasado (medido: 2026-08-08, `5f5523df9`→`942a69b89`→`aa00a3909`, a linha
// velha empurrada de volta 2 min 36 s depois do merge e deployada dali). Ali o bot COMMITOU. Sem
// commit, `git log`, `list_edits`, `get_diff` e o `fonte` da sonda ficariam todos verdes — o `fonte`
// é fingerprint DECLARADO, lido de um arquivo commitado. O hash embutido é a única rede que não
// depende de nenhum dos quatro.

describe('montarPrompt — o sha256 esperado ao lado de cada arquivo', () => {
  const f = fatia('minha-edge');
  const prompt = montarPrompt([f], PROC);

  it('emite o hash DAQUELE arquivo ao lado DAQUELE caminho, não um hash solto na página', () => {
    for (const a of f.arquivos) {
      expect(prompt).toContain(`- \`${a.caminho}\` — sha256 \`${a.sha256}\``);
    }
  });

  it('declara a PROCEDÊNCIA — hash sem commit de origem não dá para refazer no `get_message`', () => {
    expect(prompt).toContain('`origin/main` at commit `84a115a43`');
  });

  it('manda CONFERIR com o comando nomeado, não "compare os hashes" no vácuo', () => {
    expect(prompt).toContain('run `sha256sum <path>`');
  });

  it('tem os TRÊS ramos: bate → deploya · difere → aborta · NÃO CONSEGUIU medir → aborta', () => {
    expect(prompt).toContain('Every hash matches → deploy.');
    expect(prompt).toContain('ANY hash differs → **do NOT deploy.**');
    expect(prompt).toContain('**cannot compute** a hash');
    // O terceiro ramo é o que separa este bloco de um recado bem-intencionado: sem ele, o
    // `sha256sum` ausente do sandbox cai em "não achei diferença", que é ausência de dado lida
    // como aprovação (docs/historico/sonda-ausente-em-script-que-apaga.md).
    expect(prompt).toContain('Not being able to check is not');
  });

  it('fecha as duas saídas laterais que um agente prestativo inventaria: consertar e deployar parcial', () => {
    expect(prompt).toContain('Do not resolve a mismatch by editing files');
    expect(prompt).toContain('do not deploy the subset that matched');
  });

  it('vale para a LEVA também, não só para a edge sozinha', () => {
    const leva = ['a', 'b', 'c'].map(fatia);
    const p = montarPrompt(leva, PROC);
    for (const e of leva) {
      for (const a of e.arquivos) {
        expect(p).toContain(`- \`${a.caminho}\` — sha256 \`${a.sha256}\``);
      }
    }
    expect(p).toContain('run `sha256sum <path>`');
    expect(p).toContain('do NOT deploy');
  });
});

describe('blocoDeConferencia — a procedência é do PARÂMETRO, não hardcoded', () => {
  it('carrega o ref e o sha que recebeu', () => {
    const b = blocoDeConferencia({ ref: 'origin/qualquer', sha: 'deadbee' });
    expect(b).toContain('`origin/qualquer` at commit `deadbee`');
  });
});

describe('conferirCobertura — FALSIFICAÇÃO do hash e do ramo fail-closed', () => {
  const f = fatia('minha-edge');

  it('CONTROLE: o prompt intacto fica VERDE — sem isto, todo vermelho abaixo prova nada', () => {
    expect(conferirCobertura(montarPrompt([f], PROC), [f])).toEqual({ ok: true, faltando: [] });
  });

  it('FALSIFICAÇÃO: prompt com a coluna de hash AMPUTADA fica VERMELHO, nomeando cada arquivo', () => {
    // O modo de falha real: alguém "simplifica" a lista de volta para só o caminho. A colagem
    // continua parecendo completa — mesmos arquivos, mesma forma — e manda deployar sem conferir
    // nada. Se esta asserção ficar verde, o hash no prompt é decoração.
    const semHash = montarPrompt([f], PROC).replace(/ — sha256 `[0-9a-f]{64}`/g, '');
    const r = conferirCobertura(semHash, [f]);
    expect(r.ok).toBe(false);
    expect(r.faltando).toEqual(f.arquivos.map((a) => `minha-edge:${a.caminho}:sha256`));
  });

  it('FALSIFICAÇÃO: hash TROCADO entre dois arquivos fica VERMELHO (não basta "tem 64 hex")', () => {
    const trocada: EdgeParaDeploy = {
      edge: 'minha-edge',
      arquivos: [
        { caminho: f.arquivos[0].caminho, sha256: f.arquivos[1].sha256 },
        { caminho: f.arquivos[1].caminho, sha256: f.arquivos[0].sha256 },
      ],
    };
    const pedido: EdgeParaDeploy = { edge: 'minha-edge', arquivos: f.arquivos.slice(0, 2) };
    // Os dois hashes APARECEM no prompt, mas cada um ao lado do arquivo errado. O check casa
    // caminho e hash como PAR entre crases, então acusa; um `includes(hash)` solto não acusaria.
    const r = conferirCobertura(montarPrompt([trocada], PROC), pedido.arquivos.length ? [pedido] : []);
    expect(r.ok).toBe(false);
    expect(r.faltando.every((x) => x.endsWith(':sha256'))).toBe(true);
  });

  it.each(MARCAS_DE_CONFERENCIA)(
    'FALSIFICAÇÃO: prompt SEM a marca "%s" fica VERMELHO nomeando a marca',
    (marca) => {
      const mutilado = montarPrompt([f], PROC).split(marca).join('«amputado»');
      const r = conferirCobertura(mutilado, [f]);
      expect(r.ok).toBe(false);
      expect(r.faltando).toContain(`fail-closed:${marca}`);
    },
  );
});

describe('recusas — o gerador não emite colagem que aprova por vacuidade', () => {
  it('hash VAZIO lança nomeando o arquivo — comparar contra placeholder é aprovar sem medir', () => {
    const ruim: EdgeParaDeploy = {
      edge: 'x',
      arquivos: [{ caminho: 'supabase/functions/x/index.ts', sha256: '' }],
    };
    expect(() => montarPrompt([ruim], PROC)).toThrow(/sha256 ausente ou malformado/);
    expect(() => montarPrompt([ruim], PROC)).toThrow(/x:supabase\/functions\/x\/index\.ts/);
  });

  it('hash CURTO (63 hex) e hash com MAIÚSCULA também lançam — `sha256sum` imprime 64 minúsculo', () => {
    const curto = { caminho: 'a.ts', sha256: 'a'.repeat(63) };
    const maiusculo = { caminho: 'a.ts', sha256: 'A'.repeat(64) };
    expect(() => montarPrompt([{ edge: 'x', arquivos: [curto] }], PROC)).toThrow(/malformado/);
    expect(() => montarPrompt([{ edge: 'x', arquivos: [maiusculo] }], PROC)).toThrow(/malformado/);
  });

  it('CONTROLE: 64 hex minúsculo PASSA — senão as recusas acima estariam só rejeitando tudo', () => {
    const ok = { caminho: 'a.ts', sha256: 'a'.repeat(64) };
    expect(() => montarPrompt([{ edge: 'x', arquivos: [ok] }], PROC)).not.toThrow();
  });

  it('procedência sem sha (ou com sha que não é sha) lança', () => {
    expect(() => montarPrompt([fatia('x')], { ref: 'origin/main', sha: '' })).toThrow(
      /procedência inválida/,
    );
    expect(() => montarPrompt([fatia('x')], { ref: 'origin/main', sha: 'HEAD' })).toThrow(
      /procedência inválida/,
    );
    expect(() => montarPrompt([fatia('x')], { ref: '', sha: '84a115a43' })).toThrow(
      /procedência inválida/,
    );
  });
});
