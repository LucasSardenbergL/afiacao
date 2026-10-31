import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RadarComparar, MAX_COMPARAR } from '../RadarComparar';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const base = {
  bairro: null, capital_social: 10000, cep: null, cnpj: '00000000000000', cnae_descricao: 'Fabricação de móveis com predominância de madeira',
  cnae_principal: '3101200', cnaes_secundarios: [], complemento: null, created_at: '2026-01-01', data_abertura: '2010-01-01',
  descarte_motivo: null, email: null, geocode_status: null, geocoded_em: null, ja_cliente: false, lat: null, lng: null,
  logradouro: null, municipio_codigo: null, municipio_nome: 'NOVA SERRANA', nome_fantasia: null, numero: null,
  omie_cadastrado_em: null, omie_codigo_cliente: null, porte: '01', primeira_vista_em: '2026-01-01',
  prospeccao_atualizado_em: null, prospeccao_status: 'a_contatar', razao_social: 'X', rfb_situacao: null,
  rfb_situacao_data: null, rfb_situacao_lote: null, score: null, score_em: null, score_motivos: null, score_versao: null, socios_nomes: null,
  telefone1: null, telefone2: null, uf: 'MG', ultimo_lote: '2026-08', updated_at: '2026-01-01',
} satisfies RadarEmpresa;

const emp = (over: Partial<RadarEmpresa>): RadarEmpresa => ({ ...base, ...over });

describe('RadarComparar', () => {
  it('lado a lado: município, atividade, contatos e motivos do score; score ausente é "sem score", nunca 0', () => {
    render(
      <RadarComparar
        open
        onClose={() => {}}
        empresas={[
          emp({ cnpj: '11111111000111', razao_social: 'Móveis Alfa', score: 88, score_motivos: ['capital ≥ R$ 1 mi', '35 clientes no município'], telefone1: '(37) 3226-0000', email: 'alfa@x.com' }),
          emp({ cnpj: '22222222000122', razao_social: 'Beta Marmoraria', municipio_nome: 'CONTAGEM', score: null, score_motivos: ['fora da foto vigente'] }),
        ]}
      />,
    );
    const grade = screen.getByTestId('radar-comparar');
    expect(grade.textContent).toMatch(/Móveis Alfa/);
    expect(grade.textContent).toMatch(/NOVA SERRANA \/ MG/);
    expect(grade.textContent).toMatch(/CONTAGEM \/ MG/);
    expect(grade.textContent).toMatch(/3101-2\/00/);
    expect(grade.textContent).toMatch(/\(37\) 3226-0000/);
    expect(grade.textContent).toMatch(/alfa@x\.com/);
    expect(grade.textContent).toMatch(/sem telefone e sem e-mail/);
    expect(grade.textContent).toMatch(/35 clientes no município/);
    expect(grade.textContent).toMatch(/sem score/);
    expect(grade.textContent).toMatch(/fora da foto vigente/);
  });

  it(`mostra no máximo ${MAX_COMPARAR}`, () => {
    const quatro = ['1', '2', '3', '4'].map((d) => emp({ cnpj: d.repeat(14), razao_social: `Empresa ${d}` }));
    render(<RadarComparar open onClose={() => {}} empresas={quatro} />);
    expect(screen.getByText(`Comparar ${MAX_COMPARAR} empresas`)).toBeTruthy();
    expect(screen.queryByText('Empresa 4')).toBeNull();
  });
});
