import { describe, it, expect } from 'vitest';
import { montarDetalheAlvo, recenciaLabel } from './alvo-detalhe';
import type { ProspectRow } from './prospect-stop';
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

const baseAddr = {
  street: 'Rua A', number: '10', neighborhood: 'Centro',
  city: 'DIVINOPOLIS', state: 'MG', zip_code: '35500-000', complement: 'Sala 2',
};

const stopProspect = (over: Partial<RouteStop> = {}): RouteStop => ({
  id: 'prospect-12345678000190',
  stopType: 'prospect_visit',
  customerUserId: '',
  customerName: 'Móveis Beto',
  phone: '37999990000',
  address: { ...baseAddr },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null,
  status: 'prospect', visitReason: 'Prospecção',
  priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [],
  radarCnpj: '12345678000190', prospeccaoStatus: 'a_contatar',
  ...over,
});

const stopCarteira = (over: Partial<RouteStop> = {}): RouteStop => ({
  id: 'carteira-cidade-u1',
  stopType: 'sales_visit',
  customerUserId: 'u1',
  customerName: 'Marcenaria Silva',
  phone: '3733334444',
  address: { ...baseAddr },
  timeSlot: null, businessHoursOpen: null, businessHoursClose: null,
  status: 'carteira', visitReason: 'Cliente em Divinópolis',
  priorityScore: 0, priorityLabel: 'baixa', priorityFactors: [],
  diasDesdeVisita: 14,
  ...over,
});

const prospectRow = (over: Partial<ProspectRow> = {}): ProspectRow => ({
  cnpj: '12345678000190',
  razao_social: 'Beto Comercio de Moveis LTDA',
  nome_fantasia: 'Móveis Beto',
  logradouro: 'Rua A', numero: '10', complemento: 'Sala 2', bairro: 'Centro',
  municipio_nome: 'DIVINOPOLIS', uf: 'MG', cep: '35500-000',
  telefone1: '37999990000', telefone2: '3733331111',
  prospeccao_status: 'a_contatar', lat: null, lng: null, geocode_status: null, precision: null,
  ...over,
});

describe('recenciaLabel', () => {
  it('null → nunca visitado', () => {
    expect(recenciaLabel(null)).toBe('Nunca visitado');
  });
  it('0 → hoje, 1 → ontem, N → há N dias', () => {
    expect(recenciaLabel(0)).toBe('Visitado hoje');
    expect(recenciaLabel(1)).toBe('Visitado ontem');
    expect(recenciaLabel(14)).toBe('Visitado há 14 dias');
  });
});

describe('montarDetalheAlvo — prospect', () => {
  const d = montarDetalheAlvo({ stop: stopProspect(), prospectRow: prospectRow() });

  it('tipo, nome e razão social (subtítulo) distinta do nome', () => {
    expect(d.tipo).toBe('prospect');
    expect(d.nome).toBe('Móveis Beto');
    expect(d.subtitulo).toBe('Beto Comercio de Moveis LTDA');
  });
  it('CNPJ formatado e status', () => {
    expect(d.cnpjFormatado).toBe('12.345.678/0001-90');
    expect(d.statusLabel).toBe('a contatar');
    expect(d.recenciaLabel).toBeNull();
  });
  it('dois contatos (tel1+tel2): tel1 celular tem WhatsApp, tel2 fixo não', () => {
    expect(d.contatos).toHaveLength(2);
    expect(d.contatos[0].rotulo).toBe('Telefone 1');
    expect(d.contatos[0].telefone).toBe('37999990000');
    expect(d.contatos[0].whatsappHref).toBe('https://wa.me/5537999990000');
    expect(d.contatos[1].rotulo).toBe('Telefone 2');
    expect(d.contatos[1].whatsappHref).toBeNull(); // 3733331111 é fixo (10 díg)
  });
  it('endereço em linhas (rua+num, complemento, bairro, cidade-UF, CEP)', () => {
    expect(d.enderecoLinhas).toEqual([
      'Rua A, 10', 'Sala 2', 'Centro', 'DIVINOPOLIS - MG', 'CEP 35500-000',
    ]);
  });
  it('razão social igual ao nome → subtítulo null (sem redundância)', () => {
    const d2 = montarDetalheAlvo({
      stop: stopProspect({ customerName: 'Beto LTDA' }),
      prospectRow: prospectRow({ razao_social: 'Beto LTDA', nome_fantasia: null }),
    });
    expect(d2.subtitulo).toBeNull();
  });
  it('sem telefone2 → um contato só', () => {
    const d3 = montarDetalheAlvo({ stop: stopProspect(), prospectRow: prospectRow({ telefone2: null }) });
    expect(d3.contatos).toHaveLength(1);
  });
  it('sem prospectRow (fallback) → usa o phone do stop, sem razão/cnpj do raw', () => {
    const d4 = montarDetalheAlvo({ stop: stopProspect() });
    expect(d4.contatos).toHaveLength(1);
    expect(d4.contatos[0].rotulo).toBe('Telefone');
    expect(d4.cnpjFormatado).toBe('12.345.678/0001-90'); // vem do stop.radarCnpj
    expect(d4.subtitulo).toBeNull();
  });
});

describe('montarDetalheAlvo — carteira', () => {
  it('tipo carteira: sem cnpj/status/subtítulo, com recência e um contato', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira() });
    expect(d.tipo).toBe('carteira');
    expect(d.nome).toBe('Marcenaria Silva');
    expect(d.subtitulo).toBeNull();
    expect(d.cnpjFormatado).toBeNull();
    expect(d.statusLabel).toBeNull();
    expect(d.recenciaLabel).toBe('Visitado há 14 dias');
    expect(d.contatos).toHaveLength(1);
    expect(d.contatos[0].rotulo).toBe('Telefone');
  });
  it('nunca visitado → recência "Nunca visitado"', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira({ diasDesdeVisita: null }) });
    expect(d.recenciaLabel).toBe('Nunca visitado');
  });
  it('sem telefone → zero contatos (esconde a seção)', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira({ phone: null }) });
    expect(d.contatos).toHaveLength(0);
  });
  it('telefone lixo → contato existe (display cru) mas sem WhatsApp', () => {
    const d = montarDetalheAlvo({ stop: stopCarteira({ phone: '123' }) });
    expect(d.contatos).toHaveLength(1);
    expect(d.contatos[0].telefone).toBe('123');
    expect(d.contatos[0].whatsappHref).toBeNull(); // não é celular → sem WhatsApp
  });
});
