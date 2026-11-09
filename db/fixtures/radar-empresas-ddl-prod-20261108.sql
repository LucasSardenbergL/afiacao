-- DDL de public.radar_empresas lida da PROD (psql-ro, 2026-11-08): colunas (format_type), CHECKs/PK e os índices
-- (pg_indexes) — base da prova de CUSTO da publicação (db/test-radar-publicacao-curta-custo.sh). Não editar à mão:
-- regenerar com a mesma consulta se o schema mudar.
CREATE TABLE public.radar_empresas (cnpj text NOT NULL, razao_social text, nome_fantasia text, cnae_principal text NOT NULL, cnae_descricao text, cnaes_secundarios text[] NOT NULL DEFAULT '{}'::text[], data_abertura date, porte text, capital_social numeric, logradouro text, numero text, complemento text, bairro text, municipio_codigo text, municipio_nome text, uf text, cep text, telefone1 text, telefone2 text, email text, socios_nomes text, primeira_vista_em timestamp with time zone NOT NULL DEFAULT now(), ultimo_lote text NOT NULL, ja_cliente boolean NOT NULL DEFAULT false, prospeccao_status text NOT NULL DEFAULT 'a_contatar'::text, prospeccao_atualizado_em timestamp with time zone, descarte_motivo text, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), omie_codigo_cliente text, omie_cadastrado_em timestamp with time zone, lat double precision, lng double precision, geocoded_em timestamp with time zone, geocode_status text, rfb_situacao text, rfb_situacao_data date, rfb_situacao_lote text, score smallint, score_motivos text[], score_em timestamp with time zone, score_versao text, prospeccao_contato_id uuid);
ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_pkey PRIMARY KEY (cnpj);
ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_cnae_principal_check CHECK ((cnae_principal ~ '^[0-9]{7}$'::text));
ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_cnpj_check CHECK ((cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'::text));
ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_geocode_status_chk CHECK (((geocode_status IS NULL) OR (geocode_status = ANY (ARRAY['ok'::text, 'falhou'::text]))));
ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_prospeccao_status_check CHECK ((prospeccao_status = ANY (ARRAY['a_contatar'::text, 'contatado_sem_resposta'::text, 'em_conversa'::text, 'descartado'::text, 'virou_cliente'::text])));
ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_rfb_situacao_check CHECK (((rfb_situacao IS NULL) OR (rfb_situacao = ANY (ARRAY['01'::text, '02'::text, '03'::text, '04'::text, '08'::text]))));
ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_ultimo_lote_check CHECK ((ultimo_lote ~ '^[0-9]{4}-[0-9]{2}$'::text));
CREATE INDEX idx_radar_empresas_acompanhamento ON public.radar_empresas USING btree (cnpj) WHERE (prospeccao_status = ANY (ARRAY['em_conversa'::text, 'contatado_sem_resposta'::text]));
CREATE INDEX idx_radar_empresas_busca_trgm ON public.radar_empresas USING gin (razao_social extensions.gin_trgm_ops, nome_fantasia extensions.gin_trgm_ops, municipio_nome extensions.gin_trgm_ops);
CREATE INDEX idx_radar_empresas_cep ON public.radar_empresas USING btree (cep) WHERE (cep IS NOT NULL);
CREATE INDEX idx_radar_empresas_cnae ON public.radar_empresas USING btree (cnae_principal);
CREATE INDEX idx_radar_empresas_cnaes_sec ON public.radar_empresas USING gin (cnaes_secundarios);
CREATE INDEX idx_radar_empresas_email_norm ON public.radar_empresas USING btree (lower(btrim(email))) WHERE (email IS NOT NULL);
CREATE INDEX idx_radar_empresas_fila ON public.radar_empresas USING btree (ultimo_lote, prospeccao_status, data_abertura DESC);
CREATE INDEX idx_radar_empresas_ja_cliente ON public.radar_empresas USING btree (municipio_codigo, uf) WHERE ja_cliente;
CREATE INDEX idx_radar_empresas_local ON public.radar_empresas USING btree (uf, municipio_nome);
CREATE INDEX idx_radar_empresas_lote_vista ON public.radar_empresas USING btree (ultimo_lote, primeira_vista_em);
CREATE INDEX idx_radar_empresas_omie_cadastrado_em ON public.radar_empresas USING btree (omie_cadastrado_em) WHERE (omie_cadastrado_em IS NOT NULL);
CREATE INDEX idx_radar_empresas_raiz ON public.radar_empresas USING btree ("left"(cnpj, 8));
CREATE INDEX idx_radar_empresas_socios_arr ON public.radar_empresas USING gin (string_to_array(socios_nomes, '; '::text)) WHERE (socios_nomes IS NOT NULL);
CREATE INDEX idx_radar_empresas_tel1 ON public.radar_empresas USING btree (telefone1) WHERE (telefone1 IS NOT NULL);
CREATE INDEX idx_radar_empresas_tel2 ON public.radar_empresas USING btree (telefone2) WHERE (telefone2 IS NOT NULL);
CREATE INDEX idx_radar_empresas_titular_mei ON public.radar_empresas USING btree (btrim(regexp_replace(regexp_replace(razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} '::text, ''::text), ' [0-9]{11}$'::text, ''::text))) WHERE ((razao_social ~ ' [0-9]{11}$'::text) OR (razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} '::text));
CREATE INDEX idx_radar_empresas_titular_mei_norm ON public.radar_empresas USING btree (btrim(regexp_replace(upper(translate(regexp_replace(razao_social, ' [0-9]{11}$'::text, ''::text), 'áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ'::text, 'aaaaaaeeeeiiiiooooouuuucnyAAAAAAEEEEIIIIOOOOOUUUUCNY'::text)), '\s+'::text, ' '::text, 'g'::text))) WHERE (razao_social ~ ' [0-9]{11}$'::text);
CREATE INDEX idx_radar_empresas_updated_at ON public.radar_empresas USING btree (updated_at);
CREATE INDEX idx_radar_lista_estab ON public.radar_empresas USING btree (capital_social DESC, cnpj) WHERE ((ja_cliente = false) AND (prospeccao_status <> 'descartado'::text));
CREATE INDEX idx_radar_lista_novas ON public.radar_empresas USING btree (data_abertura DESC, cnpj) WHERE ((ja_cliente = false) AND (prospeccao_status <> 'descartado'::text));
CREATE INDEX idx_radar_lista_score ON public.radar_empresas USING btree (score DESC NULLS LAST, cnpj) WHERE ((ja_cliente = false) AND (prospeccao_status <> 'descartado'::text));
CREATE INDEX idx_radar_muni ON public.radar_empresas USING btree (municipio_codigo) WHERE ((ja_cliente = false) AND (prospeccao_status <> 'descartado'::text));
CREATE UNIQUE INDEX radar_empresas_omie_codigo_cliente_uniq ON public.radar_empresas USING btree (omie_codigo_cliente) WHERE (omie_codigo_cliente IS NOT NULL);
