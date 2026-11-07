import { useState } from 'react';
import { Mail, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useCronEmailSemanal, useDefinirEmailSemanal, useRadarEmailSemanalPainel } from '@/queries/useRadarEmailSemanal';
import {
  impedimentoDoEnvio,
  listaMunicipios,
  resumoUltimoEnvio,
  type ModoEmail,
  type UsuarioEmailSemanal,
} from '@/lib/radar/email-semanal';

const ROTULO_MODO: Record<ModoEmail, string> = {
  desligado: 'Desligado',
  teste: 'Teste (vai para mim)',
  ligado: 'Ligado',
};

/** Erro do supabase-js é objeto `{ message }`, não `Error`: `String(e)` mostraria "[object Object]". */
function mensagemDe(e: unknown): string {
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

type Confirmacao =
  | { tipo: 'ligar_usuario'; usuario: UsuarioEmailSemanal }
  | { tipo: 'ligar_cron'; ligados: number; emTeste: number };

/**
 * Radar D1 — liga e desliga, sem SQL Editor, o e-mail semanal de leads (5 empresas para prospectar, toda segunda às
 * 08:00) por pessoa da equipe, e o envio automático. Só master: o servidor recusa os outros (42501) e o card nem
 * aparece. Ligar para a pessoa e ligar o envio automático pedem confirmação, porque mandam e-mail de verdade.
 */
export function RadarEmailSemanalCard() {
  const { isMaster } = useAuth();
  const { isImpersonating } = useImpersonation();
  const painel = useRadarEmailSemanalPainel(isMaster);
  const definir = useDefinirEmailSemanal();
  const cron = useCronEmailSemanal();
  const [confirmar, setConfirmar] = useState<Confirmacao | null>(null);

  if (!isMaster) return null;

  const bloqueado = isImpersonating || definir.isPending || cron.isPending;

  const mudarModo = (u: UsuarioEmailSemanal, modo: ModoEmail) => {
    if (modo === u.modo) return;
    if (modo === 'ligado') {
      setConfirmar({ tipo: 'ligar_usuario', usuario: u });
      return;
    }
    aplicarModo(u, modo);
  };

  const aplicarModo = (u: UsuarioEmailSemanal, modo: ModoEmail) => {
    definir.mutate(
      { userId: u.userId, modo },
      {
        onSuccess: () => toast.success(`${u.nome ?? 'Usuário'}: e-mail semanal ${ROTULO_MODO[modo].toLowerCase()}`),
        onError: (e) => toast.error(`Não consegui mudar: ${mensagemDe(e)}`),
      },
    );
  };

  const mudarCron = (ativo: boolean, usuarios: UsuarioEmailSemanal[]) => {
    if (ativo) {
      setConfirmar({
        tipo: 'ligar_cron',
        ligados: usuarios.filter((u) => u.modo === 'ligado').length,
        emTeste: usuarios.filter((u) => u.modo === 'teste').length,
      });
      return;
    }
    aplicarCron(false);
  };

  const aplicarCron = (ativo: boolean) => {
    cron.mutate(ativo, {
      onSuccess: () => toast.success(ativo ? 'Envio automático ligado' : 'Envio automático desligado'),
      onError: (e) => toast.error(`Não consegui mudar o envio automático: ${mensagemDe(e)}`),
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Mail className="w-4 h-4" />
          E-mail semanal de leads do Radar
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Cada pessoa ligada recebe 5 empresas para prospectar nos municípios onde tem mais clientes. Em teste, o
          e-mail com os leads dela vai para você.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isImpersonating && (
          <p className="text-xs text-status-warning">Na lente "Ver como" o painel é só leitura.</p>
        )}

        {painel.isLoading && (
          <div className="space-y-2" data-testid="email-semanal-carregando">
            <Skeleton className="h-8" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}

        {painel.isError && (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-status-error">
              Não consegui ler o painel: {mensagemDe(painel.error)}
            </span>
            <Button size="sm" variant="outline" onClick={() => void painel.refetch()}>
              Tentar de novo
            </Button>
          </div>
        )}

        {painel.data && (
          <>
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div>
                <p className="text-xs font-medium">Envio automático toda segunda às 08:00</p>
                <p className="text-2xs text-muted-foreground">
                  {painel.data.cron === null
                    ? 'Agendamento não encontrado no banco: o e-mail não sai até ele existir.'
                    : painel.data.cron.ativo
                      ? 'Ligado: quem está ligado ou em teste abaixo recebe na próxima segunda.'
                      : 'Desligado: ninguém recebe, mesmo quem está ligado abaixo.'}
                </p>
              </div>
              <Switch
                aria-label="Envio automático toda segunda"
                checked={painel.data.cron?.ativo ?? false}
                disabled={bloqueado || painel.data.cron === null}
                onCheckedChange={(v) => mudarCron(v, painel.data.usuarios)}
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 font-medium text-muted-foreground">Pessoa</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">Municípios do e-mail</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">Último envio</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">E-mail semanal</th>
                  </tr>
                </thead>
                <tbody>
                  {painel.data.usuarios.map((u) => {
                    const impedimento = u.modo === 'desligado' ? null : impedimentoDoEnvio(u);
                    return (
                      <tr key={u.userId} className="border-b border-border/50 align-top">
                        <td className="py-2">
                          <p className="font-medium">{u.nome ?? 'Sem nome'}</p>
                          <p className="text-muted-foreground">{u.email ?? 'sem e-mail'}</p>
                          {impedimento && (
                            <p className="mt-1 flex items-center gap-1 text-status-warning">
                              <AlertTriangle className="w-3 h-3" />
                              {impedimento}
                            </p>
                          )}
                        </td>
                        <td className="py-2">{listaMunicipios(u.territorio)}</td>
                        <td className="py-2 text-muted-foreground">{resumoUltimoEnvio(u.ultimoEnvio)}</td>
                        <td className="py-2 text-right">
                          <Select
                            value={u.modo}
                            disabled={bloqueado}
                            onValueChange={(v) => mudarModo(u, v as ModoEmail)}
                          >
                            <SelectTrigger
                              className="h-7 w-[170px] text-xs ml-auto"
                              aria-label={`E-mail semanal de ${u.nome ?? u.userId}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="desligado">{ROTULO_MODO.desligado}</SelectItem>
                              <SelectItem value="teste">{ROTULO_MODO.teste}</SelectItem>
                              <SelectItem value="ligado">{ROTULO_MODO.ligado}</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                      </tr>
                    );
                  })}
                  {painel.data.usuarios.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center py-6 text-muted-foreground">
                        Ninguém da equipe encontrado
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmar !== null} onOpenChange={(aberto) => !aberto && setConfirmar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmar?.tipo === 'ligar_usuario'
                ? `Ligar o e-mail para ${confirmar.usuario.nome ?? 'esta pessoa'}?`
                : 'Ligar o envio automático?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmar?.tipo === 'ligar_usuario'
                ? `${confirmar.usuario.email ?? 'O e-mail do cadastro'} passa a receber 5 leads por semana, toda segunda às 08:00, enquanto o envio automático estiver ligado. Um lead enviado não se repete para ela por 90 dias.`
                : confirmar?.tipo === 'ligar_cron'
                  ? `Toda segunda às 08:00 sai o e-mail para ${confirmar.ligados} pessoa(s) ligada(s) e ${confirmar.emTeste} em teste (para você).`
                  : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmar?.tipo === 'ligar_usuario') aplicarModo(confirmar.usuario, 'ligado');
                if (confirmar?.tipo === 'ligar_cron') aplicarCron(true);
                setConfirmar(null);
              }}
            >
              Ligar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
