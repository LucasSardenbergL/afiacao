import { useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { confiancaCliente, perfilCliente, sugerirAlavanca, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { brl, dias, ROTULO_PERFIL } from './ciclo-format';

const ORDEM = { recuperar_vencido: 0, cobrar_atraso: 1, degrau_prazo: 2, nenhuma: 3 } as const;

export function CicloClientesTabela({ clientes, hoje, empresa, perfilFiltro, onAbrir }: {
  clientes: ResumoCliente[]; hoje: string; empresa: Company | 'all'; perfilFiltro: string;
  onAbrir: (c: ResumoCliente) => void;
}) {
  const linhas = useMemo(() => clientes
    .filter((c) => empresa === 'all' || c.company === empresa)
    .map((c) => ({ c, s: sugerirAlavanca(c, hoje), p: perfilCliente(c), conf: confiancaCliente(c, hoje) }))
    .filter((l) => perfilFiltro === 'todos' || l.p.perfil === perfilFiltro)
    .sort((a, b) =>
      ORDEM[a.s.alavanca] - ORDEM[b.s.alavanca]
      // só ORDENA; o R$ ausente nunca é exibido como número
      || (b.s.cenario?.reais ?? -1) - (a.s.cenario?.reais ?? -1)), [clientes, hoje, empresa, perfilFiltro]);

  return (
    <Table>
      <TableHeader><TableRow>
        <TableHead>Cliente</TableHead><TableHead>Empresa</TableHead><TableHead className="text-right">Vencido aberto</TableHead>
        <TableHead className="text-right">Docs</TableHead><TableHead className="text-right">Concedido</TableHead><TableHead className="text-right">Real</TableHead>
        <TableHead className="text-right">Atraso p80 (qtd | R$)</TableHead><TableHead>Perfil</TableHead><TableHead>Alavanca</TableHead>
        <TableHead className="text-right">Cenário</TableHead><TableHead>Confiança</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {linhas.length === 0 && (
          <TableRow><TableCell colSpan={11} className="text-sm text-muted-foreground">Nenhum cliente neste filtro.</TableCell></TableRow>
        )}
        {linhas.map(({ c, s, p, conf }) => (
          <TableRow
            key={`${c.company}:${c.omieCodigoCliente}`} className="cursor-pointer" role="button" tabIndex={0}
            onClick={() => onAbrir(c)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAbrir(c); } }}
          >
            <TableCell>{c.nomeCliente ?? `#${c.omieCodigoCliente}`}</TableCell>
            <TableCell>{COMPANIES[c.company as Company]?.shortName ?? c.company}</TableCell>
            <TableCell className="text-right font-mono">{c.saldoVencido !== null ? <span className="text-status-error">{brl(c.saldoVencido)}</span> : '—'}</TableCell>
            <TableCell className="text-right font-mono">{c.nDocumentos ?? '—'}</TableCell>
            <TableCell className="text-right font-mono">{dias(c.prazoConcedidoPond)}</TableCell>
            <TableCell className="text-right font-mono">{dias(c.prazoRealPond)}</TableCell>
            <TableCell className="text-right font-mono">{dias(c.atrasoP80)} | {dias(c.atrasoP80Valor)}</TableCell>
            <TableCell>{ROTULO_PERFIL[p.perfil]}</TableCell>
            <TableCell className="text-xs">
              {s.texto || '—'}
              {s.descontoCandidato && <Badge variant="outline" className="ml-1">desconto?</Badge>}
            </TableCell>
            <TableCell className="text-right">
              {s.cenario === null ? (
                <span className="font-mono">—</span>
              ) : (
                <>
                  <div className="font-mono">{s.cenario.reais === null ? '—' : brl(s.cenario.reais)}</div>
                  <div className="text-xs text-muted-foreground">{s.cenario.reais === null ? `${s.cenario.motivo} · ` : ''}{s.cenario.rotulo}</div>
                </>
              )}
            </TableCell>
            <TableCell><Badge variant={conf === 'media' ? 'secondary' : 'outline'}>{conf === 'media' ? 'média' : 'baixa'}</Badge></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
