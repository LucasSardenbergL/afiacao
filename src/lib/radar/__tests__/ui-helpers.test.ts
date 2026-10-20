import { describe, expect, it } from 'vitest';
import {
  ACOES_CONTATO, presetParaParams, idadeEmAnos, rotuloPorte,
  formatarCapital, formatarCnpj, digitosCnae, seloRfb, formatarDataIso, scoreUI,
} from '../ui-helpers';

describe('ACOES_CONTATO', () => {
  it('cobre o vocabulário do radar (4 ações operáveis pela UI, sem a_contatar)', () => {
    const acoes = ACOES_CONTATO.map((a) => a.acao);
    expect(acoes).toEqual(['em_conversa', 'contatado_sem_resposta', 'virou_cliente', 'descartado']);
  });
  it('só descartado pede confirmação', () => {
    expect(ACOES_CONTATO.filter((a) => a.confirmar).map((a) => a.acao)).toEqual(['descartado']);
  });
});

describe('presetParaParams', () => {
  it('score (default da fila): ordena por score desc, sem corte de idade', () => {
    const p = presetParaParams('score', '2026-06-12');
    expect(p).toEqual({ orderColumn: 'score', orderAsc: false, dataAberturaMax: null, dataAberturaMin: null });
  });
  it('novas: ordena por data_abertura desc, sem corte de idade', () => {
    const p = presetParaParams('novas', '2026-06-12');
    expect(p).toEqual({ orderColumn: 'data_abertura', orderAsc: false, dataAberturaMax: null, dataAberturaMin: null });
  });
  it('estabelecidas: corta abertura <= hoje-5anos e ordena por capital desc', () => {
    const p = presetParaParams('estabelecidas', '2026-06-12');
    expect(p).toEqual({ orderColumn: 'capital_social', orderAsc: false, dataAberturaMax: '2021-06-12', dataAberturaMin: null });
  });
});

describe('scoreUI (score de lead)', () => {
  it('NULL é estado "sem score" com o motivo do banco — nunca 0', () => {
    expect(scoreUI(null, ['fora da foto vigente'])).toEqual({ texto: 'sem score', tom: 'muted', detalhe: 'fora da foto vigente' });
    expect(scoreUI(null, ['já é cliente']).detalhe).toBe('já é cliente');
  });
  it('NULL sem motivos (coluna ainda não calculada) → "ainda não calculado"', () => {
    expect(scoreUI(null, null)).toEqual({ texto: 'sem score', tom: 'muted', detalhe: 'ainda não calculado' });
    expect(scoreUI(undefined, []).detalhe).toBe('ainda não calculado');
  });
  it('0 é score válido (não é "sem score")', () => {
    expect(scoreUI(0, [])).toEqual({ texto: '0', tom: 'neutro', detalhe: 'sem fatores pontuados' });
  });
  it('tom por faixa: ≥60 success, ≥40 info, <40 neutro', () => {
    expect(scoreUI(60, ['a']).tom).toBe('success');
    expect(scoreUI(59, ['a']).tom).toBe('info');
    expect(scoreUI(40, ['a']).tom).toBe('info');
    expect(scoreUI(39, ['a']).tom).toBe('neutro');
  });
  it('detalhe junta os motivos na ordem do banco', () => {
    expect(scoreUI(72, ['CNAE prioritário (móveis de madeira)', 'município com 12 clientes'])).toEqual({
      texto: '72', tom: 'success', detalhe: 'CNAE prioritário (móveis de madeira) · município com 12 clientes',
    });
  });
});

describe('idadeEmAnos', () => {
  it('calcula anos completos', () => expect(idadeEmAnos('2020-06-12', '2026-06-12')).toBe(6));
  it('antes do aniversário no ano conta um a menos', () =>
    expect(idadeEmAnos('2020-06-13', '2026-06-12')).toBe(5));
  it('null/vazio → null', () => {
    expect(idadeEmAnos(null, '2026-06-12')).toBeNull();
    expect(idadeEmAnos('', '2026-06-12')).toBeNull();
  });
});

describe('rotuloPorte', () => {
  it('mapeia códigos RFB', () => {
    expect(rotuloPorte('01')).toBe('ME');
    expect(rotuloPorte('03')).toBe('EPP');
    expect(rotuloPorte('05')).toBe('Demais');
    expect(rotuloPorte('00')).toBe('Não informado');
  });
  it('desconhecido/null → —', () => {
    expect(rotuloPorte(null)).toBe('—');
    expect(rotuloPorte('99')).toBe('—');
  });
});

describe('formatarCapital', () => {
  it('formata BRL sem centavos', () => expect(formatarCapital(1500000)).toBe('R$ 1.500.000'));
  it('null → —', () => expect(formatarCapital(null)).toBe('—'));
});

describe('formatarCnpj', () => {
  it('aplica a máscara', () => expect(formatarCnpj('11222333000144')).toBe('11.222.333/0001-44'));
  it('aplica a máscara ao CNPJ alfanumérico (exemplo oficial RFB)', () =>
    expect(formatarCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35'));
  it('tamanho errado → devolve cru', () => expect(formatarCnpj('123')).toBe('123'));
  it('minúscula → devolve cru (fora do formato)', () => expect(formatarCnpj('12abc34501DE35')).toBe('12abc34501DE35'));
});

describe('digitosCnae', () => {
  it('extrai dígitos do CNAE formatado', () => expect(digitosCnae('3101-2/00')).toBe('3101200'));
  it('preserva dígitos puros', () => expect(digitosCnae('3101200')).toBe('3101200'));
  it('aceita parcial (prefixo da família)', () => expect(digitosCnae('3101')).toBe('3101'));
  it('corta acima de 7 dígitos', () => expect(digitosCnae('310120099')).toBe('3101200'));
  it('vazio/null → vazio', () => {
    expect(digitosCnae('')).toBe('');
    expect(digitosCnae(null)).toBe('');
  });
});

describe('status de prospecção (rótulo + tom)', () => {
  it('cobre o vocabulário com tom semântico', async () => {
    const { rotuloStatus, tomStatus, telefonePrincipal, UFS_BR } = await import('../ui-helpers');
    expect(rotuloStatus('virou_cliente')).toBe('Virou cliente');
    expect(tomStatus('virou_cliente')).toBe('success');
    expect(tomStatus('contatado_sem_resposta')).toBe('warning');
    expect(rotuloStatus('zzz')).toBe('zzz'); // desconhecido: mostra o cru, não inventa
    expect(rotuloStatus(null)).toBe('—');
    expect(telefonePrincipal({ telefone1: null, telefone2: '31999' })).toBe('31999');
    expect(telefonePrincipal({ telefone1: null, telefone2: null })).toBeNull();
    expect(UFS_BR).toHaveLength(27);
    expect(new Set(UFS_BR).size).toBe(27);
  });
});

describe('seloRfb', () => {
  const base = { rfb_situacao: null, rfb_situacao_data: null, rfb_situacao_lote: null };
  it('03/04/08 viram selo com rótulo, data dd/mm/aaaa (sem Date) e tom', () => {
    expect(seloRfb({ rfb_situacao: '08', rfb_situacao_data: '2026-03-15', rfb_situacao_lote: '2026-08' }))
      .toEqual({ texto: 'Baixado pela RFB em 15/03/2026', tom: 'muted', titulo: 'Situação cadastral na Receita Federal (dump 2026-08): baixado desde 15/03/2026. Confira o cartão CNPJ antes de agir.' });
    expect(seloRfb({ ...base, rfb_situacao: '04', rfb_situacao_data: '2025-12-31' })?.texto).toBe('Inapto pela RFB em 31/12/2025');
    expect(seloRfb({ ...base, rfb_situacao: '03', rfb_situacao_data: '2026-05-20' })).toMatchObject({ texto: 'Suspenso pela RFB em 20/05/2026', tom: 'warning' });
  });
  it('sem data: selo sem o "em"; 02, 01 e ausente: nenhum selo (ausente ≠ ativa)', () => {
    expect(seloRfb({ ...base, rfb_situacao: '08' })?.texto).toBe('Baixado pela RFB');
    expect(seloRfb({ ...base, rfb_situacao: '02', rfb_situacao_data: '2010-01-01' })).toBeNull();
    expect(seloRfb({ ...base, rfb_situacao: '01' })).toBeNull();
    expect(seloRfb(base)).toBeNull();
  });
  it('formatarDataIso não interpreta fuso e devolve o texto cru quando não é ISO', () => {
    expect(formatarDataIso('2026-01-01')).toBe('01/01/2026');
    expect(formatarDataIso('x')).toBe('x');
  });
});
