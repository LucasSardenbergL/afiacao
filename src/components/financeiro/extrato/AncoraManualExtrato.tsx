import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatarCentavos, formatarDataIso } from '@/components/financeiro/extrato/formatar';
import { validarAncora } from '@/lib/financeiro/extrato/saldo-manual';
import type { AncoraConta } from '@/services/financeiroExtratoBancario';

interface Props {
  ancoras: AncoraConta[];
  carregando: boolean;
  erro: string | null;
  registrando: boolean;
  /** 'YYYY-MM-DD' de hoje em SP: o dia aberto, que não pode ser âncora. */
  hoje: string;
  /** Véspera do início de um arquivo pendente por falta de saldo inicial: pré-preenche a data. */
  dataSugerida?: string | null;
  onRegistrar: (data: string, saldoCentavos: number) => void;
}

/** Saldo de referência (manual): a âncora que destrava o 1º extrato de uma conta. Imutável depois de gravada. */
export function AncoraManualExtrato({ ancoras, carregando, erro, registrando, hoje, dataSugerida = null, onRegistrar }: Props) {
  const [data, setData] = useState(dataSugerida ?? '');
  const [saldo, setSaldo] = useState('');
  const [erros, setErros] = useState<{ data?: string; saldo?: string }>({});

  const enviar = () => {
    const v = validarAncora({ data, saldo }, hoje);
    if (!v.ok) {
      setErros(v.erros);
      return;
    }
    setErros({});
    onRegistrar(v.data, v.centavos);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Informe o saldo da conta ao fim de um dia já fechado (confira no app do banco). Depois de registrado, não pode ser
        alterado por aqui.
      </p>
      <p className="text-sm text-muted-foreground">
        Se o extrato ficou pendente por não ter saldo inicial, informe o saldo da véspera do primeiro dia do arquivo
        (início − 1 dia). Depois de registrar, reenvie o arquivo para ele ser reavaliado.
      </p>
      <form
        className="flex flex-wrap items-start gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          enviar();
        }}
      >
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="ancora-data">Data</label>
          <Input id="ancora-data" type="date" max={hoje} value={data} onChange={(e) => setData(e.target.value)} className="w-44" />
          {erros.data && <p className="text-xs text-status-error">{erros.data}</p>}
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="ancora-saldo">Saldo ao fim do dia (R$)</label>
          <Input
            id="ancora-saldo"
            inputMode="decimal"
            placeholder="12.345,67"
            value={saldo}
            onChange={(e) => setSaldo(e.target.value)}
            className="w-44"
          />
          {erros.saldo && <p className="max-w-xs text-xs text-status-error">{erros.saldo}</p>}
        </div>
        <div className="pt-5">
          <Button type="submit" disabled={registrando}>
            {registrando ? 'Registrando…' : 'Registrar saldo'}
          </Button>
        </div>
      </form>

      {carregando ? (
        <p className="text-sm text-muted-foreground">Carregando saldos de referência…</p>
      ) : erro ? (
        <p className="text-sm text-status-error">Falha ao carregar os saldos de referência: {erro}</p>
      ) : ancoras.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum saldo de referência registrado para esta conta.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-normal">Data</th>
              <th className="py-1 text-right font-normal">Saldo ao fim do dia</th>
              <th className="py-1 pl-4 font-normal">Origem</th>
            </tr>
          </thead>
          <tbody>
            {ancoras.map((a) => (
              <tr key={a.id} className="border-t border-border">
                <td className="py-1">{formatarDataIso(a.data)}</td>
                <td className="py-1 text-right tabular-nums">{formatarCentavos(a.saldo)}</td>
                <td className="py-1 pl-4">{a.origem}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
