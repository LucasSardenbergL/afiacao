import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

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

function fonte(over: Partial<PacoteFonte> = {}): PacoteFonte {
  const veredito: VereditoPrecondicao = { estado: 'LIBERADA', ausentes: [], naoMedidos: [], motivos: [] };
  return {
    edges: [
      {
        edge: 'disparar-pedidos-aprovados',
        arquivos: [arq('supabase/functions/disparar-pedidos-aprovados/index.ts'), arq(MAPA)],
        rpcs: ['reposicao_claim_disparo'],
      },
    ],
    alvos: [{ rpc: 'reposicao_claim_disparo', edges: ['disparar-pedidos-aprovados'] }],
    veredito,
    proc: PROC,
    ...over,
  };
}

const BLOQUEADA: VereditoPrecondicao = {
  estado: 'BLOQUEADA',
  ausentes: [{ rpc: 'reposicao_claim_disparo', edges: ['disparar-pedidos-aprovados'], familia: 22 }],
  naoMedidos: [],
  motivos: [],
};

const INCERTA: VereditoPrecondicao = {
  estado: 'INCERTA',
  ausentes: [],
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
