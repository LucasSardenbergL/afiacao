import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import {
  aplicarAtualizacao,
  assinarEstadoAtualizacao,
  obterEstadoAtualizacao,
  podeReparar,
  repararApp,
  verificarAtualizacaoAgora,
  type FaseAtualizacao,
} from '@/lib/pwa-atualizacao';
import {
  CHAVE_CONFIG_BUILD_MINIMO,
  decidirExigencia,
  formatarPrazo,
  lerConfigBuildMinimo,
  type Exigencia,
} from '@/lib/pwa-build-minimo';

/** O prazo vira bloqueio sem ninguém recarregar nada: o relógio da tela anda sozinho. */
const RELOGIO_MS = 60_000;

/**
 * Exigência de versão: banner fixo "Atualize até <prazo>" abaixo do build mínimo, e modal
 * bloqueante depois do prazo. Regras puras em `@/lib/pwa-build-minimo`.
 *
 * Só staff: a config vem de `company_config`, cuja RLS só deixa staff ler — e é o staff
 * que quebra com as migrations que fecham coluna. Pela identidade REAL (`useAuth`), não
 * pela lente: o 42501 é do JWT de quem está logado.
 *
 * Leitura que falha (offline, rede) = sem exigência: o react-query guarda o último valor
 * lido, e sem nenhum, não bloqueamos ninguém por ausência de dado.
 */
export function ExigenciaDeVersao() {
  const { isStaff } = useAuth();
  const { data: lida, error: erroDeLeitura } = useQuery({
    queryKey: ['config', CHAVE_CONFIG_BUILD_MINIMO],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_config')
        .select('value')
        .eq('key', CHAVE_CONFIG_BUILD_MINIMO)
        .maybeSingle();
      if (error) throw error;
      return lerConfigBuildMinimo(data?.value);
    },
    enabled: isStaff,
    staleTime: 5 * 60_000,
    // Voltar pro app é o momento em que o founder acabou de subir o mínimo: relê.
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 60_000,
  });
  // Falha de leitura é DECIDIDA aqui, não colapsada: sem nenhum valor lido, erro = sem
  // exigência (não se tranca o staff por ausência de dado — falhar aberto custa só o aviso);
  // com um valor já lido, o react-query o mantém e ele segue valendo durante o erro.
  const config = erroDeLeitura && lida === undefined ? null : (lida ?? null);
  const estado = useSyncExternalStore(assinarEstadoAtualizacao, obterEstadoAtualizacao);
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), RELOGIO_MS);
    return () => clearInterval(t);
  }, []);

  const exigencia = decidirExigencia({
    buildEm: estado.buildEm,
    buildServidorEm: estado.buildServidorEm,
    config: isStaff ? config : null,
    agora,
  });

  // Sensor (superfície nasce com ele) + chute na checagem: abaixo do mínimo, já começa a
  // baixar o build novo e lê o carimbo do servidor (o guard do servidor atrasado depende
  // dele). Uma vez por transição de tipo, não a cada tique do relógio.
  const tipoAnterior = useRef<Exigencia['tipo']>('nenhuma');
  useEffect(() => {
    if (exigencia.tipo === tipoAnterior.current) return;
    tipoAnterior.current = exigencia.tipo;
    if (exigencia.tipo === 'nenhuma') return;
    track('pwa.build_minimo', { exigencia: exigencia.tipo });
    void verificarAtualizacaoAgora();
  }, [exigencia.tipo]);

  if (exigencia.tipo === 'nenhuma') return null;
  const prazo = formatarPrazo(exigencia.prazo);

  if (exigencia.tipo === 'aviso') {
    return (
      <div
        role="status"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-status-warning" />
        <span className="flex-1 min-w-0">
          <strong className="font-medium">Atualize o app até {prazo}.</strong>{' '}
          <span className="text-muted-foreground">Depois disso esta versão deixa de funcionar.</span>
        </span>
        <AcaoAtualizar fase={estado.fase} />
      </div>
    );
  }

  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Atualize o app para continuar</AlertDialogTitle>
          <AlertDialogDescription>
            Esta versão expirou em {prazo}. As operações guardadas offline continuam salvas e são
            enviadas depois de atualizar.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AcaoAtualizar fase={estado.fase} />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * O botão depende da fase: pronta → aplica (o clique recarrega); falhou → reparar; sem SW
 * (preview/dev) → recarregar basta; senão → procurar/baixar a versão nova.
 */
function AcaoAtualizar({ fase }: { fase: FaseAtualizacao }) {
  if (fase === 'pronta') {
    return (
      <Button size="sm" onClick={() => aplicarAtualizacao()}>
        <RefreshCw className="mr-2 h-4 w-4" /> Atualizar
      </Button>
    );
  }
  if (fase === 'falhou') {
    return (
      <Button size="sm" onClick={() => void repararApp()} disabled={!podeReparar(fase)}>
        <Wrench className="mr-2 h-4 w-4" /> Reparar app
      </Button>
    );
  }
  if (fase === 'inativo') {
    return (
      <Button size="sm" onClick={() => globalThis.location.reload()}>
        <RefreshCw className="mr-2 h-4 w-4" /> Atualizar
      </Button>
    );
  }
  const ocupado = fase === 'verificando' || fase === 'baixando';
  return (
    <Button size="sm" onClick={() => void verificarAtualizacaoAgora()} disabled={ocupado}>
      <RefreshCw className={ocupado ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} />
      {fase === 'baixando' ? 'Baixando…' : 'Atualizar'}
    </Button>
  );
}
