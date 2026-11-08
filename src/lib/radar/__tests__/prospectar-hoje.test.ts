import { describe, expect, it } from 'vitest';
import {
  lerLinkDoEmail, lerProspectarHoje, linkFichaRadar, nomeDoLead, resumoTerritorio, textoSemTerritorio, tituloMunicipio,
} from '../prospectar-hoje';

const RESPOSTA = {
  territorio: [
    { municipio_codigo: '3122306', municipio_nome: 'DIVINOPOLIS', uf: 'MG', clientes: 358 },
    { municipio_codigo: '3147105', municipio_nome: 'PARA DE MINAS', uf: 'MG', clientes: 114 },
  ],
  leads: [
    { posicao: 1, cnpj: '00000000000101', razao_social: 'Lead Um Ltda', nome_fantasia: 'Marcenaria Um',
      municipio_nome: 'DIVINOPOLIS', uf: 'MG', score: 95, score_motivos: ['CNAE 3101', '', 7], elegiveis: 8 },
  ],
};

describe('lerProspectarHoje', () => {
  it('lê território e leads e descarta motivo vazio/não-texto', () => {
    const r = lerProspectarHoje(RESPOSTA, 'teste');
    expect(r.territorio).toEqual([
      { municipioCodigo: '3122306', municipioNome: 'DIVINOPOLIS', uf: 'MG', clientes: 358, compartilhado: false },
      { municipioCodigo: '3147105', municipioNome: 'PARA DE MINAS', uf: 'MG', clientes: 114, compartilhado: false },
    ]);
    expect(r.leads[0]).toMatchObject({ posicao: 1, cnpj: '00000000000101', score: 95, motivos: ['CNAE 3101'], elegiveis: 8 });
  });

  it('lead "visitar" (todo contato da contabilidade) vem com o endereço; sem o campo, o card de antes', () => {
    const lead = RESPOSTA.leads[0];
    const r = lerProspectarHoje({ ...RESPOSTA, leads: [
      { ...lead, visitar: true, endereco: 'Rua A 10, Centro, Divinopolis/MG' },
      { ...lead, cnpj: '00000000000202', posicao: 2, visitar: false, endereco: 'Rua B 20' },
      { ...lead, cnpj: '00000000000303', posicao: 3 },
    ] }, 'teste');
    expect(r.leads.map((l) => [l.visitar, l.endereco])).toEqual([
      [true, 'Rua A 10, Centro, Divinopolis/MG'], [false, null], [false, null],
    ]);
  });

  it('listas vazias são um resultado legítimo (sem território / sem leads)', () => {
    expect(lerProspectarHoje({ territorio: [], leads: [] }, 'teste')).toEqual({ territorio: [], leads: [], territorioMotivo: null });
  });

  it('campos do pacote E: atribuido, com_voce, compartilhado e territorio_motivo (ausentes → false/null)', () => {
    const r = lerProspectarHoje({
      territorio: [{ ...RESPOSTA.territorio[0], compartilhado: true }],
      leads: [{ ...RESPOSTA.leads[0], atribuido: true, com_voce: true }],
      territorio_motivo: null,
    }, 'teste');
    expect(r.territorio[0].compartilhado).toBe(true);
    expect(r.leads[0]).toMatchObject({ atribuido: true, comVoce: true });
    expect(lerProspectarHoje(RESPOSTA, 'teste').leads[0]).toMatchObject({ atribuido: false, comVoce: false });
    expect(lerProspectarHoje({ territorio: [], leads: [], territorio_motivo: 'sem_carteira' }, 'teste').territorioMotivo).toBe('sem_carteira');
  });

  it('textoSemTerritorio: uma copy por motivo, e a genérica para RPC antiga/código novo', () => {
    expect(textoSemTerritorio('nao_e_vendedor')).toMatch(/papel de vendedor/);
    expect(textoSemTerritorio('sem_carteira')).toMatch(/carteira está vazia/);
    expect(textoSemTerritorio('carteira_sem_municipio')).toMatch(/não têm endereço em um município do Radar/);
    expect(textoSemTerritorio(null)).toMatch(/Sua carteira não tem clientes/);
    expect(textoSemTerritorio('codigo_futuro')).toBe(textoSemTerritorio(null));
  });

  it.each([
    ['null', null],
    ['sem leads', { territorio: [] }],
    ['lead sem score (ausente não vira 0)', { territorio: [], leads: [{ ...RESPOSTA.leads[0], score: null }] }],
    ['lead sem denominador', { territorio: [], leads: [{ ...RESPOSTA.leads[0], elegiveis: 0 }] }],
    ['município sem clientes', { territorio: [{ ...RESPOSTA.territorio[0], clientes: 0 }], leads: [] }],
  ])('resposta fora do formato LANÇA com a marca da fonte: %s', (_n, data) => {
    expect(() => lerProspectarHoje(data, 'radar_prospectar_hoje')).toThrow(/^radar_prospectar_hoje: resposta fora do formato/);
  });
});

describe('apresentação', () => {
  it('nome: fantasia, senão razão social, senão CNPJ', () => {
    expect(nomeDoLead({ nomeFantasia: 'Fantasia', razaoSocial: 'Razão', cnpj: '1' })).toBe('Fantasia');
    expect(nomeDoLead({ nomeFantasia: null, razaoSocial: 'Razão', cnpj: '1' })).toBe('Razão');
    expect(nomeDoLead({ nomeFantasia: null, razaoSocial: null, cnpj: '1' })).toBe('1');
  });

  it('município em caixa de título, com partícula minúscula', () => {
    expect(tituloMunicipio('PARA DE MINAS')).toBe('Para de Minas');
    expect(tituloMunicipio('SANTO ANTONIO DO MONTE')).toBe('Santo Antonio do Monte');
    expect(tituloMunicipio(null)).toBe('');
  });

  it('resumo do território traz a contagem que o decide', () => {
    const r = lerProspectarHoje(RESPOSTA, 'teste');
    expect(resumoTerritorio(r.territorio)).toBe('Divinopolis (358) · Para de Minas (114)');
  });

  it('deep link da ficha no formato /radar?cnpj=', () => {
    expect(linkFichaRadar('00000000000101')).toBe('/radar?cnpj=00000000000101');
  });
});

describe('lerLinkDoEmail', () => {
  const ENVIO = '0f2b6c1e-3a4d-4b5e-8f60-1a2b3c4d5e6f';
  it('aceita envio uuid + CNPJ (inclusive alfanumérico) e normaliza', () => {
    expect(lerLinkDoEmail(ENVIO.toUpperCase(), '12abc34500019')).toBeNull(); // 13 caracteres
    expect(lerLinkDoEmail(ENVIO.toUpperCase(), '12abc345000195')).toEqual({ envio: ENVIO, cnpj: '12ABC345000195' });
  });
  it('recusa link malformado', () => {
    expect(lerLinkDoEmail('nao-e-uuid', '00000000000101')).toBeNull();
    expect(lerLinkDoEmail(ENVIO, undefined)).toBeNull();
    expect(lerLinkDoEmail(undefined, '00000000000101')).toBeNull();
  });
});
