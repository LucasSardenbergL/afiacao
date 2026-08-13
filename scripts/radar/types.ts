// Contrato script local → edge radar-ingest → radar_empresas (fatia 2 reusa).
//
// PROVENIÊNCIA: este arquivo vivia em `src/lib/radar/types.ts` e foi DELETADO pelo #1201
// (faxina de dead code) como "0 refs provadas". A ref existia — `scripts/radar/carga.ts`, o
// único consumidor — mas era invisível às duas ferramentas: o knip só varre `src/**` +
// `supabase/functions/**` (`project` do knip.json) e o `tsc` só varria `src/` (`include` do
// tsconfig.app.json). O TS2307 resultante ficou VERDE em todos os gates por 5 semanas, até o
// `scripts:typecheck` (2026-08-13) enxergá-lo.
//
// Restaurado AQUI, e não em `src/lib/radar/`, de propósito: `src/` está dentro do `project` do
// knip, então um tipo cujo único consumidor é `scripts/` reapareceria como export órfão e
// derrubaria o gate `bunx knip` — a mesma faxina aconteceria de novo. Co-localizar fonte e
// consumidor no mesmo módulo é a regra de fronteira do CLAUDE.md.
export type RadarEmpresaRow = {
  cnpj: string;                 // 14 dígitos
  razao_social: string | null;
  nome_fantasia: string | null;
  cnae_principal: string;       // 7 dígitos — validade garantida upstream pelo filtro DuckDB contra cnaes-alvo.txt
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
