import { describe, expect, it } from 'vitest';

import {
  ARQUIVOS_TOLERADOS_DO_BOT,
  type CommitDoBot,
  commitsSuspeitos,
  julgar,
  lerResposta,
  parsearLogDoBot,
} from './lovable-sensor-edicao';

const commit = (sha: string, assunto: string, arquivos: string[]): CommitDoBot => ({ sha, assunto, arquivos });

describe('lerResposta — o eixo da resposta do MCP', () => {
  it('[SENSOR_EDIT_ID_NA_RESPOSTA] edit_id nao-nulo e sinal de edicao', () => {
    const r = lerResposta(JSON.stringify({ message_id: 'm1', edit_id: 'e_123', status: 'done' }));
    expect(r.legivel).toBe(true);
    expect(r.sinais).toEqual(['edit_id=e_123']);
  });

  it('[SENSOR_COMMIT_SHA_ANINHADO] commit_sha aninhado, e dentro de JSON embrulhado em string, tambem', () => {
    const interno = JSON.stringify({ result: { commit_sha: 'abc1234' } });
    const r = lerResposta(JSON.stringify({ content: [{ type: 'text', text: interno }] }));
    expect(r.sinais).toEqual(['commit_sha=abc1234']);
  });

  it('[SENSOR_NULO_NAO_E_SINAL] edit_id/commit_sha nulos ou vazios nao acusam', () => {
    const r = lerResposta(JSON.stringify({ edit_id: null, commit_sha: '', editId: 'null' }));
    expect(r.sinais).toEqual([]);
  });

  it('[SENSOR_TEXTO_NAO_JSON] fora de JSON, casa a forma chave: valor e ignora a citacao solta', () => {
    expect(lerResposta('edit_id: e_9 deployed').sinais).toEqual(['edit_id=e_9']);
    expect(lerResposta('I did not produce any edit_id or commit_sha.').sinais).toEqual([]);
  });

  it('[SENSOR_RESPOSTA_VAZIA_ILEGIVEL] resposta vazia nao e "sem edicao"', () => {
    expect(lerResposta('   ').legivel).toBe(false);
  });

  it('[SENSOR_CONFIRMACAO] detecta a linha exata de confirmacao', () => {
    expect(lerResposta('Active. Hashes match.\nNo files were edited.').confirmou).toBe(true);
    expect(lerResposta('Active. Hashes match.').confirmou).toBe(false);
  });
});

describe('commits do bot — o eixo da main', () => {
  it('[SENSOR_PARSEIA_LOG] parseia registro por RS, com assunto e arquivos', () => {
    const saida =
      '\x1eeec8598d7\tChanges\n\nsupabase/functions/whatsapp-inbound/index.ts\n' +
      '\x1e5b418bfc9\tLovable update\n\nsrc/integrations/supabase/types.ts\n';
    expect(parsearLogDoBot(saida)).toEqual([
      commit('eec8598d7', 'Changes', ['supabase/functions/whatsapp-inbound/index.ts']),
      commit('5b418bfc9', 'Lovable update', ['src/integrations/supabase/types.ts']),
    ]);
  });

  it('[SENSOR_TYPES_TOLERADO] so o types.ts regenerado e tolerado; edge editada e suspeita', () => {
    expect(ARQUIVOS_TOLERADOS_DO_BOT).toContain('src/integrations/supabase/types.ts');
    const limpo = commit('a', 'Lovable update', ['src/integrations/supabase/types.ts']);
    const edge = commit('b', 'Changes', ['supabase/functions/sync-reprocess/index.ts']);
    const misto = commit('c', 'Changes', ['src/integrations/supabase/types.ts', 'src/App.tsx']);
    expect(commitsSuspeitos([limpo, edge, misto])).toEqual([edge, misto]);
  });

  it('[SENSOR_MCP_GERADO_TOLERADO] #3206: a edge mcp/index.ts e GERADA pelo @lovable.dev/mcp-js — so ela, tolerado', () => {
    expect(ARQUIVOS_TOLERADOS_DO_BOT).toContain('supabase/functions/mcp/index.ts');
    const gerado = commit('43d456c18', 'Changes', ['supabase/functions/mcp/index.ts']);
    expect(commitsSuspeitos([gerado])).toEqual([]);
  });

  it('[SENSOR_GERADO_MAIS_OUTRO_SUSPEITO] arquivo gerado junto de qualquer outro continua SUSPEITO', () => {
    const misto = commit('c', 'Changes', ['supabase/functions/mcp/index.ts', 'supabase/functions/sync-reprocess/index.ts']);
    const dupla = commit('d', 'Changes', ['src/integrations/supabase/types.ts', 'supabase/functions/mcp/index.ts', 'src/App.tsx']);
    expect(commitsSuspeitos([misto, dupla])).toEqual([misto, dupla]);
  });

  it('[SENSOR_LISTA_FECHADA] a tolerancia e lista explicita, nao prefixo: outra edge em supabase/functions/ e suspeita', () => {
    expect(ARQUIVOS_TOLERADOS_DO_BOT).toHaveLength(2);
    const vizinha = commit('e', 'Changes', ['supabase/functions/mcp-outra/index.ts']);
    expect(commitsSuspeitos([vizinha])).toEqual([vizinha]);
  });

  it('[SENSOR_INCIDENTE_3206] a leva real do bot em 2026-10-20 (72f6ad405 + 43d456c18 + squash bdeb8f298) da SEM_EDICAO', () => {
    // `git log origin/main --author=gpt-engineer-app --since=2026-10-20T01:50:00Z --format=%x1e%H%x09%s --name-only --diff-merges=first-parent`
    const log =
      '\x1ebdeb8f2985297ecb43ad6757e35cafba88f9f328\tNão publicou 3 arquivos dif.\n\n' +
      'src/integrations/supabase/types.ts\nsupabase/functions/mcp/index.ts\n' +
      '\x1e43d456c18449a84acc54e667ee42b75a0d4e5b60\tChanges\n\nsupabase/functions/mcp/index.ts\n' +
      '\x1e72f6ad4053e09b3e8db947debbd8e9ed5f2909d7\tWork in progress\n\nsrc/integrations/supabase/types.ts\n';
    const commits = parsearLogDoBot(log);
    expect(commits).toHaveLength(3);
    const suspeitos = commitsSuspeitos(commits);
    expect(suspeitos).toEqual([]);
    const resposta = lerResposta('Deployed mcp. Active. Hashes match.\nNo files were edited.');
    expect(julgar(resposta, suspeitos, true)).toBe('SEM_EDICAO');
  });
});

describe('julgar — ausencia de dado nunca vira "sem edicao"', () => {
  const limpa = { legivel: true, sinais: [], confirmou: true };
  const suspeito = [commit('b', 'Changes', ['supabase/functions/x/index.ts'])];

  it('[SENSOR_EDICAO_VENCE] qualquer eixo com edicao vence, ate com confirmacao e cedo', () => {
    expect(julgar({ ...limpa, sinais: ['edit_id=1'] }, [], true)).toBe('EDICAO_DETECTADA');
    expect(julgar(limpa, suspeito, false)).toBe('EDICAO_DETECTADA');
  });

  it('[SENSOR_CEDO_DEMAIS] main lida antes do assentamento nao e limpa', () => {
    expect(julgar(limpa, [], false)).toBe('CEDO_DEMAIS');
  });

  it('[SENSOR_SEM_CONFIRMACAO] sem a linha de confirmacao nao e SEM_EDICAO', () => {
    expect(julgar({ ...limpa, confirmou: false }, [], true)).toBe('SEM_CONFIRMACAO');
  });

  it('[SENSOR_ILEGIVEL] resposta vazia e ILEGIVEL', () => {
    expect(julgar({ legivel: false, sinais: [], confirmou: false }, [], true)).toBe('ILEGIVEL');
  });

  it('[SENSOR_LIMPO] so os tres eixos limpos dao SEM_EDICAO', () => {
    expect(julgar(limpa, [], true)).toBe('SEM_EDICAO');
  });
});
