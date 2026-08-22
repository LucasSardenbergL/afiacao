-- Sensor da cobertura (rode ANTES e DEPOIS de um ciclo do omie-analytics-sync).
SELECT account,
       count(*)                                                               AS vinculos_frescos,
       count(evidence_document_normalized)                                    AS com_evidencia,
       round(100.0*count(evidence_document_normalized)/nullif(count(*),0), 1) AS cobertura_pct
FROM public.omie_customer_account_map
WHERE source = 'document' AND updated_at >= now() - interval '7 days'
GROUP BY 1 ORDER BY 1;
