import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useRadarCadastrarOmie } from '@/queries/useRadarAcoesLead';
import { DivergenciaCadastro, ehSemConfirmacaoDoServidor, FalhaCadastro, type OpcoesCadastro } from '@/lib/radar/cadastro-omie';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/** O desfecho de UMA tentativa de cadastro, para o sensor de quem chama (sem PII). */
export type ResultadoCadastroUI = 'sucesso' | 'ja_existia' | 'indeterminado' | 'erro' | 'divergente';
type Rastrear = (resultado: ResultadoCadastroUI, retomada: boolean) => void;

/**
 * Cadastro de UM lead no Omie (Oben) com o tratamento de resultado e de RECUPERAÇÃO que a ficha e o menu de
 * contato compartilham (pacote A4: o botão da ficha tinha um `catch` genérico e perdia o "Omie confirmou, a
 * gravação no Radar falhou" — o vendedor ficava sem o caminho de volta com o código conhecido).
 *
 * A decisão continua em `@/lib/radar/cadastro-omie` (pura, testada): ela relê o vínculo e os conflitos no Radar
 * antes de tocar o Omie, então TODA retentativa abaixo é idempotente — `codigoConhecido` só repete a RPC,
 * `retentativa` volta pela edge (anti-duplicata pelo CNPJ) e `codigoVisto` vai como evidência de conflito.
 *
 * Elegibilidade (o lead ainda é cadastrável AGORA?) é de quem chama: ela é relida antes da 1ª tentativa e NÃO
 * antes de uma retomada — barrar a retomada travaria a recuperação justo quando o recruzamento já marcou
 * `ja_cliente` ou a RPC gravou e só perdeu a resposta (Codex, código 2026-10-20).
 */
export function useCadastroOmieComRecuperacao() {
  const { mutateAsync } = useRadarCadastrarOmie();
  const [cadastrando, setCadastrando] = useState(false);
  const montadoRef = useRef(true);
  useEffect(() => {
    montadoRef.current = true;
    return () => { montadoRef.current = false; };
  }, []);

  const executar = useCallback(
    async function tentar(alvo: RadarEmpresa, rastrear?: Rastrear, opcoes?: OpcoesCadastro): Promise<ResultadoCadastroUI> {
      const registrar = (r: ResultadoCadastroUI) => { rastrear?.(r, Boolean(opcoes)); return r; };
      const novamente = (o: OpcoesCadastro) => () => { void tentar(alvo, rastrear, o); };
      if (montadoRef.current) setCadastrando(true);
      try {
        const r = await mutateAsync({ empresa: alvo, opcoes });
        toast.success(
          r.jaExistia ? `Já era cliente no Omie (Oben) — reconciliado · cód. ${r.codigo}` : `Cadastrado no Omie (Oben) · cód. ${r.codigo}`,
          { description: alvo.razao_social ?? alvo.cnpj },
        );
        return registrar(r.jaExistia ? 'ja_existia' : 'sucesso');
      } catch (e) {
        const msg = mensagemDeErro(e) ?? 'erro desconhecido';
        if (/OMIE_RESPOSTA_INDETERMINADA/.test(msg)) {
          // INDETERMINADO ≠ erro: o Omie pode ter criado sem devolver o código. Nada foi gravado no Radar (o lead
          // segue na fila); a retentativa RELÊ o vínculo antes de tocar o Omie.
          toast.warning('Cadastro não confirmado pelo Omie', {
            description: 'O Omie não devolveu o código do cliente. O lead continua na fila.',
            action: { label: 'Tentar de novo', onClick: novamente({ retentativa: true }) },
          });
          return registrar('indeterminado');
        }
        if (e instanceof DivergenciaCadastro) {
          // Conflito de identidade Radar×Omie (RD001/RD002/lookup divergente): nada foi regravado e repetir não
          // resolve — sem botão de retentar (ele releria o vínculo antigo e mostraria "reconciliado").
          toast.error('Conflito de vínculo com o Omie — nada foi gravado', { description: `${msg} Confira o cadastro no Omie.` });
          return registrar('divergente');
        }
        if (ehSemConfirmacaoDoServidor(e)) {
          // A RPC não achou a confirmação que a EDGE grava (ledger omie_cliente_confirmacoes). A retentativa volta
          // pela edge (o lookup confere o documento e grava), nunca pelo "Gravar de novo"; o código visto vai
          // como EVIDÊNCIA: se o vínculo relido for outro, é conflito.
          toast.warning('Cadastro não confirmado pelo servidor', {
            description: 'O Radar não recebeu a confirmação do Omie para este CNPJ. O lead continua na fila.',
            action: {
              label: 'Tentar de novo',
              onClick: novamente({
                retentativa: true,
                ...(e instanceof FalhaCadastro && e.codigoVisto ? { codigoVisto: e.codigoVisto } : {}),
              }),
            },
          });
          return registrar('indeterminado');
        }
        if (e instanceof FalhaCadastro && e.etapa === 'radar' && e.codigo) {
          // O Omie CONFIRMOU (código em mãos) e só a gravação no Radar falhou: repetir só a RPC, com o código.
          const codigo = e.codigo;
          toast.error(`Cadastrado no Omie (cód. ${codigo}), mas o Radar não gravou o vínculo`, {
            description: msg,
            action: { label: 'Gravar de novo', onClick: novamente({ codigoConhecido: codigo }) },
          });
          return registrar('erro');
        }
        toast.error('Não foi possível cadastrar', { description: msg });
        return registrar('erro');
      } finally {
        if (montadoRef.current) setCadastrando(false);
      }
    },
    [mutateAsync],
  );

  return { executar, cadastrando };
}
