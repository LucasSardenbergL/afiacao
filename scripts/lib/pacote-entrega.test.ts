import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { PlanoDeOndas } from './ordem-entre-edges';
import { montarPacote, type PacoteFonte, shaDoPacote } from './pacote-entrega';
import type { VereditoPrecondicao } from './precondicao-banco';

const MAPA = 'supabase/functions/_shared/sonda-fingerprints.ts';

/** SHA-256 de verdade dos bytes do rótulo — o formato do #2362 é 64 hex minúsculos. */
const sha = (semente: string): string =>
  createHash('sha256').update(semente).digest('hex');

const arq = (caminho: string): { caminho: string; sha256: string } => ({
  caminho,
  sha256: sha(caminho),
});

/**
 * SHA de COMMIT tem 7..40 hex (`montarPrompt` valida) — não 64. O primeiro fixture aqui usou um
 * sha256 e foi recusado: é a MESMA classe do dialeto inventado que este PR documenta, reencenada
 * no arquivo de teste. Formato de contrato alheio copia-se do contrato, nunca se supõe.
 */
const PROC = { ref: 'origin/main', sha: sha('commit-de-teste').slice(0, 40) };

/** Leva sem manifesto de ordem: tudo liberado e nenhuma regra — o caso de toda leva até o #2469. */
const semOrdem = (edges: readonly string[]): PlanoDeOndas => ({
  liberadas: [...edges],
  retidas: [],
  regras: [],
  exigidos: [],
});

function fonte(over: Partial<PacoteFonte> = {}): PacoteFonte {
  const veredito: VereditoPrecondicao = { estado: 'LIBERADA', ausentes: [], naoMedidos: [], motivos: [], desatualizadas: [], naoConferidas: [] };
  const edges = over.edges ?? [
    {
      edge: 'disparar-pedidos-aprovados',
      arquivos: [arq('supabase/functions/disparar-pedidos-aprovados/index.ts'), arq(MAPA)],
      rpcs: ['reposicao_claim_disparo'],
    },
  ];
  return {
    edges,
    alvos: [{ rpc: 'reposicao_claim_disparo', edges: ['disparar-pedidos-aprovados'] }],
    veredito,
    proc: PROC,
    ordem: semOrdem(edges.map((e) => e.edge)),
    ...over,
  };
}

const BLOQUEADA: VereditoPrecondicao = {
  estado: 'BLOQUEADA',
  ausentes: [{ rpc: 'reposicao_claim_disparo', edges: ['disparar-pedidos-aprovados'], familia: 22 }],
  naoMedidos: [],
  motivos: [],
  desatualizadas: [],
  naoConferidas: [],
};

const INCERTA: VereditoPrecondicao = {
  estado: 'INCERTA',
  ausentes: [],
  desatualizadas: [],
  naoConferidas: [],
  naoMedidos: ['reposicao_claim_disparo'],
  motivos: ['controle positivo ZERO'],
};

describe('shaDoPacote — identidade estável, senão o SHA não serve para nada', () => {
  it('é determinístico: mesma leva, mesmo SHA', () => {
    expect(shaDoPacote(fonte())).toBe(shaDoPacote(fonte()));
  });

  it('não depende da ORDEM em que as edges/arquivos chegaram', () => {
    const a = fonte({
      edges: [
        { edge: 'b', arquivos: [arq('x'), arq('y')], rpcs: ['r_um'] },
        { edge: 'a', arquivos: [arq('q')], rpcs: [] },
      ],
    });
    const b = fonte({
      edges: [
        { edge: 'a', arquivos: [arq('q')], rpcs: [] },
        { edge: 'b', arquivos: [arq('y'), arq('x')], rpcs: ['r_um'] },
      ],
    });
    expect(shaDoPacote(a)).toBe(shaDoPacote(b));
  });

  it('MUDA quando a leva muda — senão dois pacotes diferentes teriam a mesma identidade', () => {
    const outro = fonte({ edges: [{ edge: 'outra-edge', arquivos: [arq('z')], rpcs: [] }] });
    expect(shaDoPacote(outro)).not.toBe(shaDoPacote(fonte()));
  });

  it('MUDA quando os BYTES mudam, com a mesma lista de arquivos (#2362 deu hash por arquivo)', () => {
    const mesmosNomes = fonte({
      edges: [
        {
          edge: 'disparar-pedidos-aprovados',
          arquivos: [
            { caminho: 'supabase/functions/disparar-pedidos-aprovados/index.ts', sha256: sha('OUTRO CONTEUDO') },
            arq(MAPA),
          ],
          rpcs: ['reposicao_claim_disparo'],
        },
      ],
    });
    expect(shaDoPacote(mesmosNomes)).not.toBe(shaDoPacote(fonte()));
  });

  it('MUDA quando o veredito muda: liberado e bloqueado não são o mesmo pacote', () => {
    expect(shaDoPacote(fonte({ veredito: BLOQUEADA }))).not.toBe(shaDoPacote(fonte()));
  });

  it('[PACOTE_SHA_SEM_REGRA_INALTERADO] leva sem manifesto mantém o SHA de antes da ordem entre edges', () => {
    // A forma canônica ANTERIOR, reescrita à mão: se a ordem vazar para o SHA de leva sem regra, os
    // pacotes já aplicados deixam de ser conferíveis ("apliquei ESTE pacote").
    const f = fonte();
    const antigo = createHash('sha256')
      .update(
        JSON.stringify({
          edges: [
            {
              edge: 'disparar-pedidos-aprovados',
              arquivos: f.edges[0].arquivos
                .map((a) => `${a.caminho}@${a.sha256}`)
                .sort((x, y) => x.localeCompare(y, 'en')),
              rpcs: ['reposicao_claim_disparo'],
            },
          ],
          estado: 'LIBERADA',
          ausentes: [],
        }),
      )
      .digest('hex')
      .slice(0, 12);
    expect(shaDoPacote(f)).toBe(antigo);
  });
});

describe('montarPacote — a ordem é ESTRUTURAL, não um aviso', () => {
  it('liberado: os três passos saem na ordem DDL → edges → Publish', () => {
    const { texto } = montarPacote(fonte());
    const p1 = texto.indexOf('## Passo 1 — banco');
    const p2 = texto.indexOf('## Passo 2 — edges');
    const p3 = texto.indexOf('## Passo 3 — frontend');
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
  });

  it('liberado: a colagem da edge está lá, nomeando a fatia inteira', () => {
    const { texto } = montarPacote(fonte());
    expect(texto).toContain('disparar-pedidos-aprovados');
    expect(texto).toContain(MAPA);
    expect(texto).toContain(PROC.sha.slice(0, 9));
  });

  it('BLOQUEADO: a colagem NÃO é emitida — o gate é a ausência, não um aviso ao lado', () => {
    const { texto } = montarPacote(fonte({ veredito: BLOQUEADA }));
    expect(texto).toContain('BLOQUEADO no passo 1');
    expect(texto).not.toContain('Deploy it **verbatim**');
    expect(texto).not.toContain('Deploy all of them **verbatim**');
  });

  it('INCERTO bloqueia igual: não-conseguir-medir não libera colagem', () => {
    const { texto } = montarPacote(fonte({ veredito: INCERTA }));
    expect(texto).not.toContain('verbatim');
    expect(texto).toContain('BLOQUEADO no passo 1');
  });

  it('BLOQUEADO: o Publish também some — passo 3 não roda sobre passo 1 aberto', () => {
    const { texto } = montarPacote(fonte({ veredito: BLOQUEADA }));
    expect(texto).toMatch(/Passo 3[\s\S]*Não aplicável/);
  });

  it('liberado: a pós-condição manda PROVAR, não confiar no "Active"', () => {
    const { texto } = montarPacote(fonte());
    expect(texto).toContain('bun run pendencias:deploy');
    expect(texto).toMatch(/não é prova/);
  });

  it('bloqueado: a pós-condição manda rodar o pacote de novo, não a sonda', () => {
    const { texto } = montarPacote(fonte({ veredito: BLOQUEADA }));
    expect(texto).toContain('bun run pendencias:pacote');
  });

  it('o SHA aparece no texto — o pacote diz quem ele é', () => {
    const { texto, sha } = montarPacote(fonte());
    expect(texto).toContain(sha);
  });

  it('recusa leva vazia: pacote sem passo pareceria trabalho feito', () => {
    expect(() => montarPacote(fonte({ edges: [] }))).toThrow(/leva vazia/);
  });

  it('avisa que remoção fica fora — o SW só troca de build quando o cliente clica', () => {
    expect(montarPacote(fonte()).texto).toMatch(/disponibilidade, não adoção/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ONDAS — a ordem entre edges (#2469)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// A leva do incidente: `omie-vendas-sync` exige `sync-reprocess` provada antes. O planejador
// (`ordem-entre-edges.ts`) decide a partição; aqui se prova que o MONTADOR obedece — a retida não
// entra no bloco que vai ao Lovable, e nada no pacote convida a colá-la. As marcas entre colchetes
// são as que `scripts/falsificar-ordem-entre-edges.sh` exige no vermelho.

const DUAS = [
  { edge: 'omie-vendas-sync', arquivos: [arq('supabase/functions/omie-vendas-sync/index.ts'), arq(MAPA)], rpcs: [] },
  { edge: 'sync-reprocess', arquivos: [arq('supabase/functions/sync-reprocess/index.ts'), arq(MAPA)], rpcs: [] },
];

const EM_ONDAS: PlanoDeOndas = {
  liberadas: ['sync-reprocess'],
  retidas: [
    {
      edge: 'omie-vendas-sync',
      tipo: 'ADIADA',
      espera: ['sync-reprocess'],
      motivos: ['`sync-reprocess`: está NESTA leva (exigência do #2469)'],
    },
  ],
  regras: [{ edge: 'omie-vendas-sync', depoisDe: ['sync-reprocess'] }],
  exigidos: [{ edge: 'sync-reprocess', fonte: sha('fonte-do-reprocess'), versao: 'v1.7-subtotal-liquido-pela-regua' }],
};

const emOndas = (over: Partial<PacoteFonte> = {}): PacoteFonte =>
  fonte({ edges: DUAS, alvos: [], ordem: EM_ONDAS, ...over });

/** O que vai ao Lovable: o bloco entre as cercas `~~~` do Passo 2 — `''` quando não há colagem. */
function colagem(texto: string): string {
  const passo2 = texto.slice(texto.indexOf('## Passo 2'), texto.indexOf('## Passo 3'));
  const ini = passo2.indexOf('~~~');
  return ini < 0 ? '' : passo2.slice(ini + 3, passo2.indexOf('~~~', ini + 3));
}

describe('montarPacote — em ONDAS, a retida não tem colagem', () => {
  it('[PACOTE_RETIDA_SEM_COLAGEM] a colagem nomeia só a liberada; a retida aparece fora dela', () => {
    const { texto } = montarPacote(emOndas());
    const c = colagem(texto);
    expect(c).toContain('`sync-reprocess`');
    expect(c).not.toContain('omie-vendas-sync');
    expect(texto).toContain('Retidas pela ordem entre edges');
    expect(texto).toMatch(/`omie-vendas-sync`\*\* — ADIADA/);
  });

  it('[PACOTE_NENHUMA_LIBERADA_SEM_COLAGEM] com tudo retido não há bloco para colar', () => {
    const ordem: PlanoDeOndas = {
      ...EM_ONDAS,
      liberadas: [],
      retidas: [
        ...EM_ONDAS.retidas,
        { edge: 'sync-reprocess', tipo: 'BLOQUEADA', espera: ['edge-z'], motivos: ['`edge-z`: ausente do veredito do ledger'] },
      ],
    };
    const { texto } = montarPacote(emOndas({ ordem }));
    expect(colagem(texto)).toBe('');
    expect(texto).not.toContain('verbatim');
    expect(texto).toContain('nenhuma edge desta leva tem a ordem satisfeita');
  });

  it('[PACOTE_PUBLISH_SO_NA_ULTIMA_ONDA] o Publish não aparece enquanto houver retida', () => {
    const { texto } = montarPacote(emOndas());
    expect(texto).toMatch(/Passo 3[\s\S]*depois da ÚLTIMA onda/);
    expect(texto).not.toContain('Lovable → **Publish**');
  });

  it('[PACOTE_POS_CONDICAO_DA_ONDA] a pós-condição prova a onda e manda rodar o pacote de novo', () => {
    const { texto } = montarPacote(emOndas());
    expect(texto).toContain('bun run sonda:sql sync-reprocess\n');
    expect(texto).toContain('bun scripts/pendencias-pacote.ts - < "$PEND"');
    expect(texto).toContain('prova a ONDA, não a entrega');
  });

  it('[PACOTE_PLANO_INCOERENTE_LANCA] edge sem destino, ou com dois, derruba o montador', () => {
    expect(() => montarPacote(emOndas({ ordem: semOrdem(['sync-reprocess']) }))).toThrow(/plano de ondas/);
    expect(() =>
      montarPacote(emOndas({ ordem: { ...EM_ONDAS, liberadas: ['sync-reprocess', 'omie-vendas-sync'] } })),
    ).toThrow(/plano de ondas/);
  });

  it('[PACOTE_SHA_MUDA_COM_A_PARTICAO] liberada e retida não são o mesmo pacote', () => {
    const tudoLiberado: PlanoDeOndas = { ...EM_ONDAS, liberadas: ['omie-vendas-sync', 'sync-reprocess'], retidas: [] };
    expect(shaDoPacote(emOndas({ ordem: tudoLiberado }))).not.toBe(shaDoPacote(emOndas()));
  });

  it('[PACOTE_SHA_IGNORA_MOTIVOS] o motivo carrega idade — o SHA não pode mudar com o relógio', () => {
    const outroMotivo: PlanoDeOndas = {
      ...EM_ONDAS,
      retidas: [{ ...EM_ONDAS.retidas[0], motivos: ['`sync-reprocess`: provada há 3 min'] }],
    };
    expect(shaDoPacote(emOndas({ ordem: outroMotivo }))).toBe(shaDoPacote(emOndas()));
  });

  it('[PACOTE_ORDEM_NAO_ANULA_O_PASSO_1] DDL bloqueada segue sem colagem, com ou sem ondas', () => {
    const { texto } = montarPacote(emOndas({ veredito: BLOQUEADA }));
    expect(colagem(texto)).toBe('');
    expect(texto).toContain('BLOQUEADO no passo 1');
  });
});
