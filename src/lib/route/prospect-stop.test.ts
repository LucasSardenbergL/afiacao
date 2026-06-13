import { describe, it, expect } from 'vitest';
import {
  prospectRowToStopDraft,
  buildGeocodeQuery,
  labelProspeccaoStatus,
  type ProspectRow,
} from './prospect-stop';

const base: ProspectRow = {
  cnpj: '00000000000001',
  razao_social: 'METALÚRGICA EXEMPLO LTDA',
  nome_fantasia: 'EXEMPLO',
  logradouro: 'RUA DAS FERRAMENTAS',
  numero: '123',
  complemento: 'GALPÃO 2',
  bairro: 'CENTRO',
  municipio_nome: 'BETIM',
  uf: 'MG',
  cep: '32600000',
  telefone1: '3133334444',
  telefone2: '3199998888',
  prospeccao_status: 'a_contatar',
  lat: null,
  lng: null,
  geocode_status: null,
};

describe('prospectRowToStopDraft', () => {
  it('mapeia os campos da RPC para o draft de parada', () => {
    const d = prospectRowToStopDraft(base);
    expect(d.id).toBe('prospect-00000000000001');
    expect(d.radarCnpj).toBe('00000000000001');
    expect(d.customerName).toBe('EXEMPLO'); // nome_fantasia tem prioridade
    expect(d.phone).toBe('3133334444'); // telefone1 tem prioridade
    expect(d.address).toEqual({
      street: 'RUA DAS FERRAMENTAS',
      number: '123',
      neighborhood: 'CENTRO',
      city: 'BETIM',
      state: 'MG',
      zip_code: '32600000',
      complement: 'GALPÃO 2',
    });
    expect(d.prospeccaoStatus).toBe('a_contatar');
    expect(d.visitReason).toBe('Prospecção'); // a_contatar não anexa sufixo
  });

  it('cai para razao_social quando não há nome_fantasia, e para cnpj quando não há nenhum', () => {
    expect(prospectRowToStopDraft({ ...base, nome_fantasia: null }).customerName).toBe(
      'METALÚRGICA EXEMPLO LTDA',
    );
    expect(
      prospectRowToStopDraft({ ...base, nome_fantasia: '  ', razao_social: null }).customerName,
    ).toBe('00000000000001');
  });

  it('usa telefone2 quando telefone1 vazio, e null quando nenhum', () => {
    expect(prospectRowToStopDraft({ ...base, telefone1: '' }).phone).toBe('3199998888');
    expect(prospectRowToStopDraft({ ...base, telefone1: null, telefone2: null }).phone).toBeNull();
  });

  it('adota lat/lng só quando geocode_status=ok com ambos não-null', () => {
    const ok = prospectRowToStopDraft({ ...base, geocode_status: 'ok', lat: -19.97, lng: -44.2 });
    expect(ok.lat).toBe(-19.97);
    expect(ok.lng).toBe(-44.2);
    expect(ok.geocodeFailed).toBeUndefined();
  });

  it('marca geocodeFailed quando status=falhou (sem lat/lng)', () => {
    const f = prospectRowToStopDraft({ ...base, geocode_status: 'falhou' });
    expect(f.geocodeFailed).toBe(true);
    expect(f.lat).toBeUndefined();
    expect(f.lng).toBeUndefined();
  });

  it('status NULL = nunca tentado: sem lat/lng e sem geocodeFailed (geocodifica depois)', () => {
    const d = prospectRowToStopDraft(base);
    expect(d.lat).toBeUndefined();
    expect(d.lng).toBeUndefined();
    expect(d.geocodeFailed).toBeUndefined();
  });

  it('não adota lat/lng se status=ok mas algum coord é null (defensivo)', () => {
    const d = prospectRowToStopDraft({ ...base, geocode_status: 'ok', lat: -19.9, lng: null });
    expect(d.lat).toBeUndefined();
    expect(d.lng).toBeUndefined();
  });

  it('anexa o status legível ao visitReason quando não é a_contatar', () => {
    expect(prospectRowToStopDraft({ ...base, prospeccao_status: 'em_conversa' }).visitReason).toBe(
      'Prospecção · em conversa',
    );
    expect(
      prospectRowToStopDraft({ ...base, prospeccao_status: 'contatado_sem_resposta' }).visitReason,
    ).toBe('Prospecção · sem resposta');
  });

  it('campos de endereço nulos viram strings vazias; complemento vazio vira undefined', () => {
    const d = prospectRowToStopDraft({
      ...base,
      logradouro: null,
      numero: null,
      bairro: null,
      cep: null,
      complemento: '',
    });
    expect(d.address.street).toBe('');
    expect(d.address.number).toBe('');
    expect(d.address.complement).toBeUndefined();
  });
});

describe('buildGeocodeQuery', () => {
  it('monta rua, número, cidade, uf, Brazil', () => {
    expect(buildGeocodeQuery({ street: 'Rua A', number: '10', city: 'Betim', state: 'MG' })).toBe(
      'Rua A, 10, Betim, MG, Brazil',
    );
  });

  it('pula partes vazias', () => {
    expect(buildGeocodeQuery({ street: 'Rua A', number: '', city: 'Betim', state: 'MG' })).toBe(
      'Rua A, Betim, MG, Brazil',
    );
    expect(buildGeocodeQuery({ street: '', number: '', city: 'Betim', state: 'MG' })).toBe(
      'Betim, MG, Brazil',
    );
  });

  it('trim nas partes', () => {
    expect(buildGeocodeQuery({ street: '  Rua A  ', city: ' Betim ', state: 'MG' })).toBe(
      'Rua A, Betim, MG, Brazil',
    );
  });
});

describe('labelProspeccaoStatus', () => {
  it('traduz os status conhecidos e ecoa o desconhecido', () => {
    expect(labelProspeccaoStatus('a_contatar')).toBe('a contatar');
    expect(labelProspeccaoStatus('em_conversa')).toBe('em conversa');
    expect(labelProspeccaoStatus('xpto')).toBe('xpto');
  });
});
