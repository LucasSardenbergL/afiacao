import { describe, expect, it } from 'vitest';

import {
  ARQUIVOS_TOLERADOS_DO_BOT,
  ASSENTAR_MIN_PADRAO,
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
    expect([...ARQUIVOS_TOLERADOS_DO_BOT]).toEqual(['src/integrations/supabase/types.ts']);
    const limpo = commit('a', 'Lovable update', ['src/integrations/supabase/types.ts']);
    const edge = commit('b', 'Changes', ['supabase/functions/sync-reprocess/index.ts']);
    const misto = commit('c', 'Changes', ['src/integrations/supabase/types.ts', 'src/App.tsx']);
    expect(commitsSuspeitos([limpo, edge, misto])).toEqual([edge, misto]);
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

  it('[SENSOR_ASSENTAR_COBRE_ATRASO_MEDIDO] o assentamento padrao cobre o atraso medido de 27/09', () => {
    // resposta 16:42:55Z, commits do bot 16:58:00Z -> 15,1 min
    const atrasoMedidoMin = (Date.parse('2026-09-27T16:58:00Z') - Date.parse('2026-09-27T16:42:55Z')) / 60_000;
    expect(ASSENTAR_MIN_PADRAO).toBeGreaterThanOrEqual(2 * atrasoMedidoMin);
  });

  it('[SENSOR_LIMPO] so os tres eixos limpos dao SEM_EDICAO', () => {
    expect(julgar(limpa, [], true)).toBe('SEM_EDICAO');
  });
});
