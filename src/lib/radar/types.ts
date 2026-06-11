// Contrato script local → edge radar-ingest → radar_empresas (fatia 2 reusa).
export type RadarEmpresaRow = {
  cnpj: string;                 // 14 dígitos
  razao_social: string | null;
  nome_fantasia: string | null;
  cnae_principal: string;       // 7 dígitos
  cnae_descricao: string | null;
  cnaes_secundarios: string[];
  data_abertura: string | null; // YYYY-MM-DD
  porte: string | null;
  capital_social: number | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio_codigo: string | null;
  municipio_nome: string | null;
  uf: string | null;
  cep: string | null;
  telefone1: string | null;
  telefone2: string | null;
  email: string | null;
  socios_nomes: string | null;
};

export type RadarMunicipioRow = {
  codigo: string; nome: string; uf: string;
  lat: number | null; lng: number | null;
};
