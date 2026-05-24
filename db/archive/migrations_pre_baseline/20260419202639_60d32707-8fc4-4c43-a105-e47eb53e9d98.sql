-- Política para permitir UPDATE em sku_parametros para staff (admin/employee/manager)
CREATE POLICY "staff can update sku_parametros"
ON public.sku_parametros
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'employee', 'manager')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'employee', 'manager')
  )
);

-- Trigger para registrar histórico ao aprovar / alterar parâmetros
CREATE OR REPLACE FUNCTION public.registrar_historico_sku_parametros()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Só registra se houve mudança em campos relevantes
  IF (OLD.estoque_minimo IS DISTINCT FROM NEW.estoque_minimo)
     OR (OLD.ponto_pedido IS DISTINCT FROM NEW.ponto_pedido)
     OR (OLD.estoque_maximo IS DISTINCT FROM NEW.estoque_maximo)
     OR (OLD.aprovado_em IS DISTINCT FROM NEW.aprovado_em)
     OR (OLD.aplicar_no_omie IS DISTINCT FROM NEW.aplicar_no_omie) THEN
    INSERT INTO public.sku_parametros_historico (
      sku_parametro_id, snapshot_em, classe_consolidada,
      demanda_media_diaria, lt_medio_dias_uteis, z_score,
      estoque_seguranca, ponto_pedido, trigger
    ) VALUES (
      NEW.id, now(), NEW.classe_consolidada,
      NEW.demanda_media_diaria, NEW.lt_medio_dias_uteis, NEW.z_score,
      NEW.estoque_seguranca, NEW.ponto_pedido,
      CASE
        WHEN OLD.aprovado_em IS DISTINCT FROM NEW.aprovado_em AND NEW.aprovado_em IS NOT NULL THEN 'aprovacao_humana'
        WHEN OLD.estoque_minimo IS DISTINCT FROM NEW.estoque_minimo
          OR OLD.ponto_pedido IS DISTINCT FROM NEW.ponto_pedido
          OR OLD.estoque_maximo IS DISTINCT FROM NEW.estoque_maximo THEN 'edicao_manual'
        ELSE 'atualizacao'
      END
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_historico_sku_parametros ON public.sku_parametros;
CREATE TRIGGER trg_historico_sku_parametros
AFTER UPDATE ON public.sku_parametros
FOR EACH ROW
EXECUTE FUNCTION public.registrar_historico_sku_parametros();