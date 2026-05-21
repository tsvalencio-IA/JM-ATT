# JM Guinchos — V17 Fluxo Único Financeiro Operacional

Esta versão corrige o problema estrutural de módulos independentes. A regra aplicada foi: o usuário lança uma vez e o sistema replica/vincula nos pontos corretos.

## Principais correções

- Despesa lançada pelo motorista agora leva automaticamente dados do chamado, veículo, motorista, seguradora/pagador, protocolo e placa do cliente quando houver chamado selecionado.
- Aprovação de despesa pelo gestor/financeiro cria ou atualiza uma saída financeira determinística em `transactions/expense_{expenseId}`, evitando duplicidade por clique duplo.
- Despesa de manutenção aprovada pode aparecer também no histórico de manutenção do veículo quando o aprovador tem permissão de frota.
- Manutenção lançada na frota cria/atualiza automaticamente uma saída financeira em `transactions/maintenance_{maintenanceId}`.
- Recebimento vinculado a chamado atualiza/cria a conta a receber oficial em `transactions/call_receivable_{callId}` em vez de gerar lançamento duplicado.
- Chamado finalizado com valor gera conta a receber automaticamente quando o usuário tem permissão financeira; se não tiver, o chamado fica como `a_faturar` para o financeiro.
- Financeiro ganhou fila de “Chamados finalizados/a faturar sem financeiro oficial”.
- Chamados passam a receber `financialSummary` com previsto, pago, saldo, custo, lucro e margem.
- Exclusão de lançamento recalcula os vínculos do chamado.
- Resultado da frota deixou de subtrair manutenção duas vezes: manutenção lançada no financeiro já entra como custo financeiro.

## Coleções preservadas

- `calls`: chamado operacional.
- `expenses`: solicitação de despesa do motorista.
- `transactions`: livro financeiro oficial.
- `maintenance`: eventos de manutenção da frota.
- `vehicles`: frota.
- `users`: equipe.
- `auditLogs`: auditoria.

## Regra operacional

Chamado → Frota → Motorista → Despesa → Financeiro → KPI.

O sistema não deve exigir lançar a mesma informação em vários lugares.

## Cache/PWA

Versão de cache: `jm-guinchos-fluxo-unico-financeiro-v17`.

Abra após publicar:

- `jm.html?v=jm-v17-fluxo-unico-financeiro-operacional`
- `motorista.html?v=jm-v17-fluxo-unico-financeiro-operacional`

## Firestore Rules

Não foram criadas coleções novas. As regras atuais da V16 continuam compatíveis, desde que já permitam:

- motorista criar `expenses`;
- financeiro criar/editar `transactions`;
- gestor/gerente criar/editar `maintenance`;
- financeiro atualizar `calls` ao recalcular vínculos.
