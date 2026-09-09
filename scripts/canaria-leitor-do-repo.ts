// canaria-leitor-do-repo.ts — COMO se lê, do repo, o marcador que cada canária serve.
//
// Por que num módulo próprio, e não inline nos dois chamadores: o marcador esperado é DERIVADO do
// repo de propósito (digitá-lo é a via do veredito falso que o `sonda-versao-sql` existe para
// fechar), e há DOIS caminhos que precisam dele — a CLI operacional (`scripts/sonda-versao-sql.ts`,
// bloco `import.meta.main`) e a prova executada (`db/lib/gerar-canaria-fixture.ts`, consumida por
// `db/test-canaria-veredito.sh`). Duas cópias de "onde mora o marcador" divergiriam, e a divergência
// seria invisível: a prova continuaria VERDE julgando um SQL que não é o que o operador cola.
//
// Ele NÃO é importado no topo do `sonda-versao-sql.ts` — lá a importação é dinâmica, dentro do
// `import.meta.main`. O motivo é concreto: o eval da skill `lovable-deploy-verify` COPIA só
// `sonda-versao-sql.ts` e `sonda-fingerprint.ts` para um diretório temporário, e um import de topo
// para `supabase/functions/` ou `@/` não resolve nesse contexto — foi assim que 7 cenários do eval
// passaram a devolver `SQL_VAZIO`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { removerComentarios } from '@/lib/gates/limpeza-fonte';

import { localizarCanarias } from './canaria-contrato-bump-gate';
import { relIndex, type LeitorCanariasDoRepo } from './sonda-versao-sql';

/**
 * O leitor que a CLI e a prova executada compartilham.
 *
 * Reusa o extrator do gate `canaria:bump` (`localizarCanarias`) pelo mesmo motivo: duas regras de
 * "onde mora o marcador" divergiriam, e a que não tem gate é a que decide errado. O stripper é o
 * COMPARTILHADO (`removerComentarios`) — regex local não sabe o que é string e apagaria o miolo do
 * arquivo antes da medição.
 */
export const lerCanariasDoRepo: LeitorCanariasDoRepo = (raiz, edge) => {
  const caminho = relIndex(edge);
  // UMA leitura, e os bytes saem junto: é este `index.ts` que o guard de sincronia confere contra a
  // `origin/main`, e conferir uma SEGUNDA leitura aprovaria bytes que o marcador não atravessou.
  const bytes = readFileSync(join(raiz, caminho), 'utf8');
  return { canarias: localizarCanarias(removerComentarios(bytes)), fonte: { caminho, bytes } };
};
