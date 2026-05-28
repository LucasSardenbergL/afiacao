// CSV puro do relatório de clientes não-vinculados.
// Delimitador ';' (Excel pt-BR abre direto); o BOM UTF-8 é adicionado no download (não aqui).

export interface NaoVinculadoCsvRow {
  omie_codigo_cliente: number;
  cnpj_cpf: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
}

const DELIM = ';';
const HEADER = ['codigo_omie', 'cnpj_cpf', 'razao_social', 'nome_fantasia', 'cidade', 'uf', 'codigo_vendedor'];

function cell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  if (s.includes(DELIM) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(rows: NaoVinculadoCsvRow[]): string {
  const lines = [HEADER.join(DELIM)];
  for (const r of rows) {
    lines.push([
      cell(r.omie_codigo_cliente),
      cell(r.cnpj_cpf),
      cell(r.razao_social),
      cell(r.nome_fantasia),
      cell(r.cidade),
      cell(r.uf),
      cell(r.codigo_vendedor),
    ].join(DELIM));
  }
  return lines.join('\r\n');
}
