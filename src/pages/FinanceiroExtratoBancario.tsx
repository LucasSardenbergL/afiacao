import { useMemo } from 'react';
import { Landmark } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { UploadExtrato } from '@/components/financeiro/extrato/UploadExtrato';
import { ListaArquivosExtrato } from '@/components/financeiro/extrato/ListaArquivosExtrato';
import { ResumoDiarioExtrato } from '@/components/financeiro/extrato/ResumoDiarioExtrato';
import { AncoraManualExtrato } from '@/components/financeiro/extrato/AncoraManualExtrato';
import { hojeSaoPaulo } from '@/lib/financeiro/extrato/saldo-manual';
import {
  useAncorasConta,
  useArquivosExtrato,
  useContasBancarias,
  useImportarExtrato,
  useMarcarConferido,
  useRegistrarAncora,
  useResumoDiarioExtrato,
} from '@/hooks/useFinanceiroExtratoBancario';
import { useUrlState } from '@/hooks/useUrlState';
import { limitesDoMes, vesperaDoPendenteSemSaldo } from '@/components/financeiro/extrato/formatar';
import { useAuth } from '@/contexts/AuthContext';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/** 'YYYY-MM' do mês corrente (America/Sao_Paulo) como padrão do filtro. */
function mesAtual(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date());
  return p.slice(0, 7);
}

export default function FinanceiroExtratoBancario() {
  // isStaff REAL (não o da lente "Ver como"): a edge só aceita JWT de staff.
  const { isStaff } = useAuth();
  const mesPadrao = useMemo(mesAtual, []);
  const [filtros, setFiltros] = useUrlState({ conta: '', mes: mesPadrao });
  const contas = useContasBancarias();
  const lista = contas.data ?? [];
  const conta = lista.find((c) => c.id === filtros.conta) ?? lista[0] ?? null;
  const contaId = conta?.id ?? null;
  const janela = limitesDoMes(filtros.mes) ?? limitesDoMes(mesPadrao);
  const de = janela?.de ?? '';
  const ate = janela?.ate ?? '';

  const arquivos = useArquivosExtrato(contaId);
  const resumo = useResumoDiarioExtrato(janela ? contaId : null, de, ate);
  const importar = useImportarExtrato(conta);
  const conferir = useMarcarConferido();
  const ancoras = useAncorasConta(contaId);
  const registrarAncora = useRegistrarAncora(contaId);

  const dataSugerida = vesperaDoPendenteSemSaldo(arquivos.data ?? []);

  if (contas.isLoading) return <PageSkeleton variant="list" />;
  if (contas.error) {
    return (
      <EmptyState
        tone="operational"
        icon={Landmark}
        title="Não foi possível carregar as contas bancárias"
        description={mensagemDeErro(contas.error) ?? 'Erro desconhecido.'}
      />
    );
  }
  if (!conta) {
    return (
      <EmptyState
        tone="operational"
        icon={Landmark}
        title="Nenhuma conta bancária cadastrada"
        description="Sem conta bancária, não há onde importar extrato."
      />
    );
  }

  return (
    <div className="space-y-6 p-4">
      <header className="space-y-1">
        <h1 className="font-display text-2xl">Extrato bancário</h1>
        <p className="text-sm text-muted-foreground">Importe o extrato do banco e confira o saldo de cada dia.</p>
      </header>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="extrato-conta">Conta</label>
          <Select value={conta.id} onValueChange={(v) => setFiltros({ conta: v })}>
            <SelectTrigger id="extrato-conta" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              {lista.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.descricao ?? `Banco ${c.bancoCodigo}`} · {c.company}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="extrato-mes">Mês</label>
          <input
            id="extrato-mes"
            type="month"
            value={filtros.mes}
            onChange={(e) => e.target.value && setFiltros({ mes: e.target.value })}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
        {isStaff && (
          <UploadExtrato desabilitado={false} enviando={importar.isPending} onArquivo={(f) => importar.mutate(f)} />
        )}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Resumo diário</CardTitle></CardHeader>
        <CardContent>
          {resumo.isLoading ? (
            <PageSkeleton variant="list" />
          ) : resumo.error ? (
            <p className="text-sm text-status-error">Falha ao carregar o resumo: {mensagemDeErro(resumo.error) ?? 'erro desconhecido'}</p>
          ) : (
            <ResumoDiarioExtrato dias={resumo.data ?? []} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Saldo de referência (manual)</CardTitle></CardHeader>
        <CardContent>
          <AncoraManualExtrato
            key={`${conta.id}:${dataSugerida ?? ''}`}
            dataSugerida={dataSugerida}
            ancoras={ancoras.data ?? []}
            carregando={ancoras.isLoading}
            erro={ancoras.error ? (mensagemDeErro(ancoras.error) ?? 'erro desconhecido') : null}
            registrando={registrarAncora.isPending}
            hoje={hojeSaoPaulo()}
            onRegistrar={(data, saldoCentavos) => registrarAncora.mutate({ data, saldoCentavos })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Arquivos importados</CardTitle></CardHeader>
        <CardContent>
          {arquivos.isLoading ? (
            <PageSkeleton variant="list" />
          ) : arquivos.error ? (
            <p className="text-sm text-status-error">Falha ao carregar os arquivos: {mensagemDeErro(arquivos.error) ?? 'erro desconhecido'}</p>
          ) : (arquivos.data ?? []).length === 0 ? (
            <EmptyState tone="operational" icon={Landmark} title="Nenhum arquivo importado" description="Importe um extrato OFX ou CNAB 240 para começar." />
          ) : (
            <ListaArquivosExtrato
              arquivos={arquivos.data ?? []}
              conferindoId={conferir.isPending ? (conferir.variables ?? null) : null}
              onConferir={(id) => conferir.mutate(id)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
