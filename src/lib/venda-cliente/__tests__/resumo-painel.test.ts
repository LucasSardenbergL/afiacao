import { describe, expect, it } from 'vitest';
import type { Json } from '@/integrations/supabase/types';
import { lerResumoPainel } from '../resumo-painel';

// Forma montada por `venda_resumo_painel` (migration 20261113110200) — chaves sempre presentes, exceto os braços.
function base(): { [k: string]: Json } {
  return {
    periodo: { de: '2026-11-13', ate: '2026-11-20' },
    hoje: '2026-11-20',
    sorteio: { inicio: '2026-11-13', fracao_controle: 0.15, algoritmo: 'md5-32-v1', realizado_em: '2026-11-12T18:00:00Z',
      compradores: 279, controle: 41 },
    dias: [{ dia: '2026-11-13', farmer_user_id: 'f1', nome: 'Regina', envio_status: 'notificado',
      enviado_em: '2026-11-13T10:00:00Z', aberto_em: null, tentativa: 1, entregues: 6, clicadas: 2, tentativas: 3,
      ofertadas: 2, acesso_validado: true, copia_status: 'notificado' }],
    farmers: [{ farmer_user_id: 'f1', nome: 'Regina', primeiro_envio: '2026-11-13', dias_com_envio: 1,
      dias_acesso_validado: 1, entregues: 6, clicadas: 2, tentativas: 3, ofertadas: 2, taxa_ofertada: 0.3333,
      status: 'medindo' }],
    efeito: { tratamento: { compradores: 6, maduros: 0, converteram: 0, nao_medivel: 0, sem_linhas: 0, taxa: null },
      diferenca: null, ic95: null, aviso: 'aviso' },
    aa_historico: { controle: { virou: 10, nao_virou: 90, taxa: 0.1 }, tratamento: { virou: 50, nao_virou: 450, taxa: 0.1 } },
  };
}

describe('borda de venda_resumo_painel', () => {
  it('lê a forma completa; braço ausente = null (sem dado), não zero', () => {
    const r = lerResumoPainel(base());
    expect(r.farmers[0].status).toBe('medindo');
    expect(r.efeito.controle).toBeNull();
    expect(r.efeito.tratamento?.taxa).toBeNull();
    expect(r.dias[0].aberto_em).toBeNull();
    expect(r.sorteio?.controle).toBe(41);
  });

  it('sorteio NULL é aceito (antes da migration não há sorteio)', () => {
    expect(lerResumoPainel({ ...base(), sorteio: null }).sorteio).toBeNull();
  });

  it('chave ausente, tipo trocado e status desconhecido LANÇAM com a marca do campo', () => {
    const sem = base(); delete sem.dias;
    expect(() => lerResumoPainel(sem)).toThrow('painel: sem "dias"');
    const troca = base(); (troca.farmers as { [k: string]: Json }[])[0].entregues = '6';
    expect(() => lerResumoPainel(troca)).toThrow('farmers[0]: "entregues" não é número');
    const st = base(); (st.farmers as { [k: string]: Json }[])[0].status = 'talvez';
    expect(() => lerResumoPainel(st)).toThrow('status desconhecido "talvez"');
    const ic = base(); (ic.efeito as { [k: string]: Json }).ic95 = [0.1];
    expect(() => lerResumoPainel(ic)).toThrow('"ic95" fora da forma');
  });
});
