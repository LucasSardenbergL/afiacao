// Sheet de decisão do Raio-X (fase B, PR 3; UX da 2ª revisão, 2026-11). Money-path: "tirar do motor" grava em
// sku_parametros via `raio_x_decidir`. Regras que espelham o SQL ficam em `@/lib/reposicao/raio-x/decisao` (testadas lá).
// UM formulário e UM salvar para decisão + execução (UX 5): com destino que tem execução, responsável/prazo (e piso/canal
// no liquidar) aparecem antes do 1º salvar, e salvar chama `raio_x_decidir` e depois `raio_x_planejar` — acabou o
// travamento entre dois rascunhos (bug 1). "Confirmar: <sugestão>" é o atalho de 1 toque: o toque explícito É a decisão;
// a pré-seleção passiva sozinha continua não sendo.
import { useEffect, useMemo, useState } from 'react';
import { useReposicaoEmpresa } from '@/contexts/ReposicaoEmpresaContext';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useIsTouchDevice } from '@/hooks/useIsTouchDevice';
import { useRegisterShortcuts } from '@/components/shell/ShortcutsRegistry';
import { DESTINOS, ROTULOS, ROTULOS_ESPERA } from '@/lib/reposicao/raio-x/classificar';
import {
  argsEstadoSalvo,
  assinaturaServidor,
  empresaDoRaioX,
  estadoMotor,
  lerNumero,
  MSG_NUMERO_INVALIDO,
  seloFaseA,
  sugestaoInicial,
  type DecidirArgs,
} from '@/lib/reposicao/raio-x/decisao';
import {
  CANAIS,
  custoEsperarMensal,
  ehExecutavel,
  concluidoVigente,
  prazoPadrao,
  ROTULO_CANAL,
} from '@/lib/reposicao/raio-x/execucao';
import { hojeSP } from '@/lib/time/sp-day';
import type { CanalLiquidacao, Categoria, DecisaoRow, Destino, Empresa, ItemRaioX, TrocaContrapartida } from '@/lib/reposicao/raio-x/tipos';
import { useRaioXMutacoes, type OrigemDecisao, type PlanoJunto } from './useRaioXMutacoes';
import type { MembroEquipe } from './useExecucaoRaioX';
import { fmtReais, fmtValor, fmtValorFino } from './formato';

const ROTULO_CATEGORIA: Record<Categoria, string> = {
  mercadoria: 'Mercadoria',
  uso_consumo: 'Uso e consumo / insumo',
  nao_mercadoria: 'Não-mercadoria',
};

const TEXTO_MOTOR = {
  colacor: 'sem motor de reposição — nada a desligar',
  sem_parametro: 'sem parâmetro de reposição — nada a desligar',
  ja_fora: 'já fora do motor',
} as const;

/** Fila do Top 61 (UX 3): progresso e "Pular". Ausente = painel aberto fora da fila. */
export interface FilaSheet {
  decididos: number;
  total: number;
  /** R$ do Top 61 ainda sem decisão (null = sem custo conhecido). */
  pendente: number | null;
  onPular: () => void;
}

interface Props {
  /** Empresa do ITEM aberto (capturada ao abrir). Se o seletor mudar, o Sheet fecha. */
  empresa: Empresa;
  item: ItemRaioX;
  decisao: DecisaoRow | undefined;
  onClose: () => void;
  /** Gravou (decisão, ou decisão sem o plano): na fila abre o próximo; fora dela, fecha. Default = onClose. */
  onSalvo?: () => void;
  /** taxa anual de custo de capital (lida pela aba); null/ausente = custo de esperar não exibido. */
  taxa?: number | null;
  /** quem pode ser responsável (lido pela aba). */
  equipe?: MembroEquipe[];
  /** usuário REAL (useAuth) — responsável padrão = quem decide. */
  userId?: string | null;
  fila?: FilaSheet | null;
  /** origem do toque para o sensor; ausente = 'fila' com fila, 'sheet' sem. */
  origem?: OrigemDecisao;
}

export function DecisaoSheet({ empresa, item, decisao, onClose, onSalvo, taxa = null, equipe = [], userId = null, fila = null, origem }: Props) {
  const { empresa: empresaCtx } = useReposicaoEmpresa();
  const empresaDoSeletor = empresaDoRaioX(empresaCtx);
  const custoMes = custoEsperarMensal(item.valor, taxa);
  // "Recarregar" (S9) remonta o formulário com as props novas.
  const [versao, setVersao] = useState(0);

  // Trocar a empresa no seletor com o Sheet aberto fecha: o item é de outra empresa (Review Focus 4).
  useEffect(() => {
    if (empresaDoSeletor !== empresa) onClose();
  }, [empresaDoSeletor, empresa, onClose]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          {fila && (
            // pr-8: o "Pular" não pode encostar no X de fechar do Sheet (toque errado fecha a fila)
            <div data-testid="fila-cabecalho" className="flex items-center justify-between gap-2 pr-8 text-xs text-muted-foreground">
              <span>
                {fila.decididos} de {fila.total} decididos · {fila.pendente === null ? 'R$ —' : fmtReais(fila.pendente)} pendente
              </span>
              <Button size="sm" variant="ghost" onClick={fila.onPular}>Pular</Button>
            </div>
          )}
          <SheetTitle>{item.descricao ?? item.codigo}</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{item.codigo}</span> · {ROTULO_CATEGORIA[item.categoria]} ·{' '}
            {item.fora_do_estoque ? `foto da coorte ${fmtValor(item.valor_coorte ?? null)}` : fmtValor(item.valor)}
            {custoMes !== null && <> · custa ~{fmtReais(custoMes)}/mês parado</>}
          </SheetDescription>
        </SheetHeader>
        {/* remonta ao trocar de item ou recarregar: estado local (sujo, campos) nunca vaza entre SKUs nem sobrevive a refetch */}
        <FormDecisao
          key={`${empresa}-${item.sku_codigo_omie}-${versao}`}
          empresa={empresa}
          item={item}
          decisao={decisao}
          onClose={onClose}
          onSalvo={onSalvo ?? onClose}
          onRecarregar={() => setVersao((v) => v + 1)}
          equipe={equipe}
          userId={userId}
          origem={origem ?? (fila ? 'fila' : 'sheet')}
        />
      </SheetContent>
    </Sheet>
  );
}

/** Converte número do banco para o campo pt-BR ("12,5"); null → vazio. */
const paraCampo = (n: number | null) => (n === null ? '' : String(n).replace('.', ','));

function FormDecisao({ empresa, item, decisao, onClose, onSalvo, onRecarregar, equipe = [], userId = null, origem }: Omit<Props, 'fila' | 'origem'> & {
  onSalvo: () => void;
  onRecarregar: () => void;
  origem: OrigemDecisao;
}) {
  const m = useRaioXMutacoes(empresa);
  const touch = useIsTouchDevice();
  const sugerido = item.fora_do_estoque ? null : sugestaoInicial(item);
  const gravado = decisao?.destino ?? null;
  // S8: "tirar do motor" só nasce marcado sem decisão gravada; com decisão gravada, só ao escolher um destino
  // DIFERENTE do gravado (ou marcar à mão). Re-salvar uma decisão nunca desliga o motor por padrão.
  const tirarPadrao = (d: Destino | null) => gravado === null || d !== gravado;
  const [destino, setDestino] = useState<Destino | null>(gravado ?? sugerido);
  const [tirar, setTirar] = useState(() => tirarPadrao(gravado ?? sugerido));
  // S9: assinatura do servidor ao abrir. Se mudar com o painel aberto (outro operador, restaurar, refetch),
  // o rascunho está velho: gravar apagaria campos ou religaria/desligaria o motor sem querer.
  const [assinaturaAoAbrir] = useState(() => assinaturaServidor(item, decisao));
  const velho = assinaturaAoAbrir !== assinaturaServidor(item, decisao);
  const [observacao, setObservacao] = useState(decisao?.observacao ?? '');
  const [fornecedor, setFornecedor] = useState(decisao?.fornecedor_informado ?? '');
  const [credito, setCredito] = useState(
    decisao?.credito_troca != null ? String(decisao.credito_troca).replace('.', ',') : '',
  );
  const [erroCredito, setErroCredito] = useState(false);
  // A pré-seleção sozinha não é decisão: "Salvar" só depois de um toque (ou o toque em "Confirmar: <sugestão>").
  const [sujo, setSujo] = useState(false);

  // ── Plano de execução (pacote 2), no MESMO formulário ──
  // Plano NUNCA gravado: os padrões (responsável = quem decide, prazo = min(hoje + 14, meta)) são a proposta e vão no
  // 1º salvar. Plano existente: nulo gravado fica nulo (não "repõe" responsável/prazo apagados de propósito).
  const semPlano = !decisao || (decisao.responsavel === null && decisao.prazo === null && decisao.preco_piso === null
    && decisao.canal_liquidacao === null && decisao.concluido_em === null && decisao.frete_estimado === null && decisao.troca_contrapartida === null);
  // "quem decide": numa decisão já gravada é quem a gravou; numa nova, quem está decidindo agora
  const [responsavel, setResponsavel] = useState(semPlano
    ? ((gravado ? decisao?.decidido_por : null) ?? userId ?? '')
    : (decisao?.responsavel ?? ''));
  const [prazo, setPrazo] = useState(semPlano ? prazoPadrao(hojeSP()) : (decisao?.prazo ?? ''));
  // A versão que o formulário edita (o Sheet remonta ao recarregar): vai como p_atualizado_em → RX003 se mudou.
  const [atualizadoEm] = useState(decisao?.atualizado_em ?? null);
  const concluidoGravado = decisao ? concluidoVigente(decisao) : false;
  const [concluido, setConcluido] = useState(concluidoGravado);
  const [piso, setPiso] = useState(gravado === 'liquidar' ? paraCampo(decisao?.preco_piso ?? null) : '');
  const [canal, setCanal] = useState<CanalLiquidacao | ''>(gravado === 'liquidar' ? (decisao?.canal_liquidacao ?? '') : '');
  const [frete, setFrete] = useState(gravado === 'liquidar' ? paraCampo(decisao?.frete_estimado ?? null) : '');
  const [contrapartida, setContrapartida] = useState<TrocaContrapartida | ''>(gravado === 'trocar' ? (decisao?.troca_contrapartida ?? '') : '');
  const [erroPiso, setErroPiso] = useState(false);
  const [erroFrete, setErroFrete] = useState(false);
  const [planoSujo, setPlanoSujo] = useState(false);
  const tocarPlano = () => setPlanoSujo(true);

  // Item fora do estoque (linha histórica da coorte): o motor não foi lido — nada é desligado daqui.
  const motor = item.fora_do_estoque ? null : estadoMotor(empresa, item, destino);
  const fase = seloFaseA(decisao);
  const podeTirarAgora = fase && estadoMotor(empresa, item, decisao?.destino) === 'pode_tirar';
  const executavel = ehExecutavel(destino);

  const tocar = () => setSujo(true);

  const escolherDestino = (d: Destino) => {
    tocar();
    if (d !== destino) {
      setTirar(tirarPadrao(d));
      // "executado" é do destino gravado: trocar de destino nunca herda a execução da decisão anterior
      setConcluido(d === gravado ? concluidoGravado : false);
    }
    setDestino(d);
  };

  // Desktop: teclas 1–6 escolhem o destino (a confirmação continua sendo o "Salvar"). Fora de campos de texto.
  const atalhos = useMemo(
    () => (touch ? [] : DESTINOS.map((d, i) => ({
      keys: String(i + 1),
      label: `Destino: ${ROTULOS[d]}`,
      group: 'Raio-X',
      handler: () => escolherDestino(d),
    }))),
    // escolherDestino muda a cada render; o registro só precisa da identidade por destino/estado
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [touch, destino, gravado],
  );
  useRegisterShortcuts(atalhos);

  /** Plano do formulário; piso/canal/frete só no liquidar e contrapartida só no trocar (o servidor recusaria o resto). */
  const montarPlano = (d: Destino): { plano: PlanoJunto | null; erro: boolean } => {
    let precoPiso: number | null = null;
    let freteNum: number | null = null;
    if (d === 'liquidar') {
      const r = lerNumero(piso);
      if (r.erro) {
        setErroPiso(true);
        return { plano: null, erro: true };
      }
      precoPiso = r.valor;
      if (frete.trim() !== '') {
        const rf = lerNumero(frete);
        if (rf.erro) {
          setErroFrete(true);
          return { plano: null, erro: true };
        }
        freteNum = rf.valor;
      }
    }
    setErroPiso(false);
    setErroFrete(false);
    return {
      erro: false,
      plano: {
        precoPiso,
        frete: freteNum,
        canal: d === 'liquidar' && canal ? canal : null,
        trocaContrapartida: d === 'trocar' && contrapartida ? contrapartida : null,
        responsavel: responsavel || null,
        prazo: prazo || null,
        concluido,
      },
    };
  };

  /** Decisão + (se o destino tem execução) plano. `confirmando` = toque em "Confirmar: <sugestão>". */
  const salvar = async (confirmando = false) => {
    if (!destino || velho) return;
    const mudouDecisao = sujo || confirmando || gravado === null;
    let creditoTroca: number | null = null;
    if (destino === 'trocar') {
      const r = lerNumero(credito);
      if (r.erro) {
        setErroCredito(true);
        return;
      }
      creditoTroca = r.valor;
    }
    setErroCredito(false);
    const args: DecidirArgs | null = mudouDecisao ? {
      sku: item.sku_codigo_omie,
      destino,
      categoria: item.categoria,
      observacao: observacao.trim() || null,
      // Fornecedor só é editável quando o cadastro não tem; senão preserva o já informado (S2).
      fornecedor: !item.fornecedor ? fornecedor.trim() || null : (decisao?.fornecedor_informado ?? null),
      creditoTroca,
      tirarDoMotor: motor === 'pode_tirar' && tirar,
      restaurarMotor: false,
    } : null;
    let plano: PlanoJunto | null = null;
    if (executavel && (args !== null || planoSujo || semPlano)) {
      const r = montarPlano(destino);
      if (r.erro) return;
      plano = r.plano;
    }
    if (!args && !plano) return;
    const res = await m.salvar(args, plano, { sku: item.sku_codigo_omie, atualizadoEm, origem });
    if (res !== 'falhou') onSalvo();
  };

  const restaurar = async () => {
    if (velho) return;
    if (await m.decidir(argsEstadoSalvo(item, decisao, { restaurarMotor: true }), 'restaurar')) onClose();
  };

  const tirarAgora = async () => {
    if (velho) return;
    if (await m.decidir(argsEstadoSalvo(item, decisao, { tirarDoMotor: true }), 'tirar_agora')) onClose();
  };

  // Sem decisão gravada, só o toque no destino (ou o "Confirmar") vale como decisão — mexer só na execução de um
  // destino pré-selecionado não grava a pré-seleção.
  const podeSalvar = !!destino && !m.pendente && !velho
    && (gravado === null ? sujo : (sujo || planoSujo || (ehExecutavel(gravado) && semPlano)));
  // decisão + execução vão juntas no mesmo botão (a seção Execução está à vista); só a execução mexida → "Salvar execução"
  const rotuloSalvar = !sujo && gravado !== null && executavel ? 'Salvar execução' : 'Salvar decisão';
  const confirmavel = sugerido !== null && gravado === null && destino === sugerido && !velho;
  const motorDoSugerido = sugerido ? estadoMotor(empresa, item, sugerido) : null;
  const unidadeVenda = item.unidades_venda && new Set(item.unidades_venda).size === 1 ? item.unidades_venda[0] : null;
  // Responsável gravado que não está na lista (saiu da equipe / leitura falhou): aparece pelo id, não some.
  const opcoes = responsavel && !equipe.some((e) => e.user_id === responsavel)
    ? [...equipe, { user_id: responsavel, nome: `(fora da lista) ${responsavel.slice(0, 8)}` }]
    : equipe;

  return (
    <div className="mt-4 space-y-5 text-sm">
      {velho && (
        <div role="alert" className="space-y-2 rounded-md border border-status-error/40 bg-status-error/5 p-3">
          <p className="text-status-error">Esta decisão mudou enquanto o painel estava aberto — recarregue</p>
          <Button size="touch" variant="outline" onClick={onRecarregar}>Recarregar</Button>
        </div>
      )}
      {item.fora_do_estoque && (
        <p role="status" className="rounded-md border border-status-warning/40 bg-status-warning/5 p-3 text-status-warning">
          Saiu do estoque (saldo zerado) depois do congelamento da coorte e segue na meta. Registre o que aconteceu — o
          motor de compra não é lido nem alterado por esta linha.
        </p>
      )}
      {fase && (
        <div className="space-y-2 rounded-md border border-status-warning/40 bg-status-warning/5 p-3">
          <p className="text-status-warning">decidido na fase A — motor não foi tocado</p>
          {podeTirarAgora && (
            <Button size="touch" variant="outline" disabled={m.pendente || velho} onClick={tirarAgora}>
              tirar do motor agora
            </Button>
          )}
        </div>
      )}

      {confirmavel && sugerido && (
        <section className="space-y-1 rounded-md border p-3">
          <Button size="touch" className="w-full" disabled={m.pendente} onClick={() => void salvar(true)}>
            Confirmar: {ROTULOS[sugerido]}
          </Button>
          <p className="text-xs text-muted-foreground">
            {item.motivo_destino}
            {motorDoSugerido === 'pode_tirar' && tirar && ' · tira do motor de compra'}
            {ehExecutavel(sugerido) && ' · responsável e prazo abaixo'}
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="font-medium">{confirmavel ? 'Outro destino' : 'Destino'}</h3>
        {item.destino_sugerido && !confirmavel && (
          <p className="text-xs text-muted-foreground">
            sugerido: {ROTULOS[item.destino_sugerido] ?? item.destino_sugerido}
            {item.motivo_destino ? ` — ${item.motivo_destino}` : ''}
          </p>
        )}
        <div role="group" aria-label="Destino" className="grid grid-cols-2 gap-2">
          {DESTINOS.map((d, i) => (
            <Button
              key={d}
              type="button"
              size="touch"
              className="h-auto whitespace-normal py-2 leading-tight"
              variant={destino === d ? 'default' : 'outline'}
              aria-pressed={destino === d}
              aria-keyshortcuts={touch ? undefined : String(i + 1)}
              onClick={() => escolherDestino(d)}
            >
              {!touch && <kbd aria-hidden className="mr-1 font-sans text-xs opacity-60">{i + 1}</kbd>}
              {ROTULOS[d]}
            </Button>
          ))}
        </div>
      </section>

      {motor && (
        <section>
          {motor === 'pode_tirar' ? (
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={tirar}
                onChange={(e) => {
                  tocar();
                  setTirar(e.target.checked);
                }}
              />
              tirar do motor
            </label>
          ) : (
            <p className="text-muted-foreground">{TEXTO_MOTOR[motor]}</p>
          )}
        </section>
      )}

      {destino === 'liquidar' && destino !== gravado && item.inequivoco === false && (
        <p role="status" className="text-xs text-status-warning" data-testid="aviso-rx004">
          O servidor recusa liquidar fora do inequívoco (decisão do founder: só o inequívoco agora). Aguarda: {item.motivos_espera.map((m) => ROTULOS_ESPERA[m] ?? m).join(', ')}.
        </p>
      )}
      {destino === 'trocar' && (
        <section className="space-y-1">
          <label htmlFor="rx-credito" className="font-medium">Crédito de troca (R$)</label>
          <Input
            id="rx-credito"
            inputMode="decimal"
            value={credito}
            aria-invalid={erroCredito}
            onChange={(e) => {
              tocar();
              setErroCredito(false);
              setCredito(e.target.value);
            }}
          />
          {erroCredito && <p className="text-xs text-status-error">{MSG_NUMERO_INVALIDO}</p>}
        </section>
      )}

      {executavel && (
        <section aria-label="Execução" className="space-y-3 rounded-md border p-3">
          <h3 className="font-medium">Execução</h3>
          <div className="space-y-1">
            <label htmlFor="rx-resp" className="block text-xs">Responsável</label>
            <select
              id="rx-resp"
              className="h-11 w-full rounded-md border bg-background px-2"
              value={responsavel}
              onChange={(e) => { tocarPlano(); setResponsavel(e.target.value); }}
            >
              <option value="">— sem responsável —</option>
              {opcoes.map((e) => <option key={e.user_id} value={e.user_id}>{e.nome}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="rx-prazo" className="block text-xs">Prazo</label>
            <Input id="rx-prazo" type="date" value={prazo} onChange={(e) => { tocarPlano(); setPrazo(e.target.value); }} />
          </div>
          {destino === 'liquidar' && (
            <>
              <div className="space-y-1">
                <label htmlFor="rx-piso" className="block text-xs">
                  Preço piso (R$ por {unidadeVenda ?? 'unidade de venda'})
                </label>
                <Input
                  id="rx-piso"
                  inputMode="decimal"
                  value={piso}
                  aria-invalid={erroPiso}
                  onChange={(e) => { tocarPlano(); setErroPiso(false); setPiso(e.target.value); }}
                />
                {erroPiso && <p className="text-xs text-status-error">{MSG_NUMERO_INVALIDO}</p>}
                <p className="text-xs text-muted-foreground">
                  referência: CMC {item.cmc !== null ? fmtValorFino(item.cmc) : '—'}
                  {item.unidade_estoque ? `/${item.unidade_estoque}` : ''} · preço médio 12m{' '}
                  {item.preco_medio_12m !== null ? fmtValorFino(item.preco_medio_12m) : '—'}
                  {!unidadeVenda && ' · mais de uma unidade de venda: a medição não compara com o piso'}
                  {unidadeVenda && item.unidade_estoque && unidadeVenda !== item.unidade_estoque
                    && ` · vende em ${unidadeVenda} e estoca em ${item.unidade_estoque}: margem sobre o CMC indisponível`}
                </p>
              </div>
              <div className="space-y-1">
                <label htmlFor="rx-canal" className="block text-xs">Canal</label>
                <select
                  id="rx-canal"
                  className="h-11 w-full rounded-md border bg-background px-2"
                  value={canal}
                  onChange={(e) => { tocarPlano(); setCanal(e.target.value as CanalLiquidacao | ''); }}
                >
                  <option value="">— sem canal —</option>
                  {CANAIS.map((c) => <option key={c} value={c}>{ROTULO_CANAL[c]}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">detalhe (qual cliente, qual promoção) vai na observação</p>
              </div>
              <div className="space-y-1">
                <label htmlFor="rx-frete" className="block text-xs">Frete estimado (R$ total da liquidação)</label>
                <Input id="rx-frete" inputMode="decimal" value={frete} aria-invalid={erroFrete} onChange={(e) => { tocarPlano(); setErroFrete(false); setFrete(e.target.value); }} />
                {erroFrete && <p className="text-xs text-status-error">{MSG_NUMERO_INVALIDO}</p>}
                {gravado === 'liquidar' && decisao && (decisao.desconto_sobre_medio_pct !== null || decisao.margem_unit !== null) && (
                  <p className="text-xs text-muted-foreground">
                    gravado: {decisao.desconto_sobre_medio_pct !== null ? `desconto ${Math.round(decisao.desconto_sobre_medio_pct * 100)}% sobre o médio ${decisao.preco_medio_base !== null ? fmtValorFino(decisao.preco_medio_base) : '—'}` : 'desconto — (sem venda em 12m ou unidade de venda não única)'}
                    {decisao.margem_unit !== null ? ` · margem ${fmtValorFino(decisao.margem_unit)}/un sobre CMC ${decisao.cmc_base !== null ? fmtValorFino(decisao.cmc_base) : '—'}` : ' · margem — (sem CMC ou unidade de venda ≠ do estoque)'}
                  </p>
                )}
              </div>
            </>
          )}
          {destino === 'trocar' && (
            <div className="space-y-1">
              <label htmlFor="rx-contrapartida" className="block text-xs">O que entra no lugar</label>
              <select id="rx-contrapartida" className="h-11 w-full rounded-md border bg-background px-2" value={contrapartida}
                onChange={(e) => { tocarPlano(); setContrapartida(e.target.value as TrocaContrapartida | ''); }}>
                <option value="">— não informado —</option>
                <option value="giro">produto que gira (conta no critério da meta)</option>
                <option value="encalhe">outro encalhe (não libera nada)</option>
              </select>
            </div>
          )}
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={concluido} onChange={(e) => { tocarPlano(); setConcluido(e.target.checked); }} />
            executado
          </label>
          <p className="text-xs text-muted-foreground">marca a tarefa — o R$ liberado continua vindo só da medição</p>
        </section>
      )}

      <section className="space-y-1">
        {!item.fornecedor ? (
          <>
            <label htmlFor="rx-fornecedor" className="font-medium">Fornecedor</label>
            <Input
              id="rx-fornecedor"
              value={fornecedor}
              placeholder="sem fornecedor no cadastro"
              onChange={(e) => {
                tocar();
                setFornecedor(e.target.value);
              }}
            />
          </>
        ) : (
          <p><span className="text-muted-foreground">Fornecedor:</span> {decisao?.fornecedor_informado || item.fornecedor}</p>
        )}
      </section>

      <section className="space-y-1">
        <label htmlFor="rx-obs" className="font-medium">Observação</label>
        <Textarea
          id="rx-obs"
          value={observacao}
          onChange={(e) => {
            tocar();
            setObservacao(e.target.value);
          }}
        />
      </section>

      {/* ação fixa no rodapé (mobile: sem rolar até o fim do painel) */}
      <div className="sticky bottom-0 -mx-6 border-t bg-background px-6 py-3">
        <Button size="touch" className="w-full" disabled={!podeSalvar} onClick={() => void salvar()}>
          {rotuloSalvar}
        </Button>
      </div>

      {decisao?.motor_antes != null && (
        <section className="space-y-2 border-t pt-4">
          <p className="text-xs text-status-warning">
            repõe exatamente o estado anterior; ajustes manuais feitos depois serão desfeitos
          </p>
          <Button size="touch" variant="outline" disabled={m.pendente || velho} onClick={restaurar}>
            Restaurar motor ao estado anterior
          </Button>
        </section>
      )}

      <Reclassificar item={item} pendente={m.pendente} onSalvar={async (c, motivo) => {
        if (await m.classificar(item.sku_codigo_omie, c, motivo)) onClose();
      }} />
    </div>
  );
}

function Reclassificar({ item, pendente, onSalvar }: {
  item: ItemRaioX;
  pendente: boolean;
  onSalvar: (c: Categoria, motivo: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [categoria, setCategoria] = useState<Categoria>(item.categoria);
  const [motivo, setMotivo] = useState('');

  if (!aberto) {
    return (
      <div className="border-t pt-4">
        <button type="button" className="min-h-11 text-xs underline underline-offset-2" onClick={() => setAberto(true)}>
          reclassificar
        </button>
      </div>
    );
  }
  return (
    <section className="space-y-2 border-t pt-4">
      <h3 className="font-medium">Reclassificar</h3>
      <p className="text-xs text-muted-foreground">Regra atual: {item.motivo_categoria || ROTULO_CATEGORIA[item.categoria]}</p>
      <label htmlFor="rx-cat" className="block text-xs">Nova categoria</label>
      <select
        id="rx-cat"
        className="h-11 w-full rounded-md border bg-background px-2"
        value={categoria}
        onChange={(e) => setCategoria(e.target.value as Categoria)}
      >
        {(Object.keys(ROTULO_CATEGORIA) as Categoria[]).map((c) => (
          <option key={c} value={c}>{ROTULO_CATEGORIA[c]}</option>
        ))}
      </select>
      <label htmlFor="rx-motivo" className="block text-xs">Motivo</label>
      <Input id="rx-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="obrigatório" />
      <Button size="touch" variant="outline" disabled={!motivo.trim() || pendente} onClick={() => onSalvar(categoria, motivo)}>
        Salvar classificação
      </Button>
    </section>
  );
}
