# JM Guinchos — v13 Financeiro, Frota e KPI Profissional

Versão: `jm-financeiro-frota-kpi-v13`

## O que esta versão evoluiu

- Financeiro profissional com entrada, saída, transferência e ajuste.
- Edição e exclusão de lançamentos financeiros pelo gestor/dono.
- Exclusões críticas gravam auditoria em `auditLogs`.
- Controle de categoria, centro de custo, veículo, motorista, chamado, vencimento, pagamento e forma de pagamento.
- KPIs de receita, despesa, lucro bruto e margem.
- KPIs por veículo e por motorista.
- Exportação CSV do financeiro.
- Controle de manutenção da frota com geração automática de custo financeiro.
- Lucratividade por veículo dentro da tela Frota.
- DRE rápido por chamado.
- Cancelamento de chamado com motivo e auditoria.
- Exclusão definitiva de chamado somente para gestor/dono.
- Motorista mantém painel separado e visualiza KPIs próprios, sem ver lucro total da empresa.
- Mantido mapa gratuito Leaflet/OpenStreetMap e Tracker RAFA.
- Mantido fluxo de login corrigido.

## Arquivos principais alterados

- `jm.html`
- `motorista.html`
- `js/app.js`
- `js/motorista.js`
- `js/superadmin.js`
- `firestore.rules`
- `service-worker.js`
- `README_JM_GUINCHOS.md`

## Regras Firestore

Publique o arquivo `firestore.rules` no Firebase Console. Subir o arquivo no GitHub não atualiza as regras do Firestore automaticamente.

## Perfis e poderes

- Gestor/Admin: controla chamados, financeiro, frota, equipe, exclusões e auditoria.
- Financeiro: lança/edita financeiro e aprova despesas, sem excluir usuários/tracker.
- Gerente: opera chamados, frota/manutenção e visão de gestão.
- Auxiliar/Atendente: opera chamados sem poder financeiro crítico.
- Motorista: vê seus chamados, altera status e lança despesas.

## Teste obrigatório após publicar

1. Abrir `jm.html?v=jm-financeiro-frota-kpi-v13`.
2. Entrar como `jm@jm.com`.
3. Criar um chamado com veículo e motorista.
4. Finalizar o chamado e conferir se gerou receita.
5. Abrir Financeiro, editar e excluir um lançamento.
6. Conferir `auditLogs` no Firestore após exclusão.
7. Lançar manutenção na Frota e conferir custo criado no Financeiro.
8. Entrar no `motorista.html?v=jm-financeiro-frota-kpi-v13` e lançar despesa.
9. Aprovar despesa no gestor e conferir custo vinculado a motorista/veículo.

## Observação técnica importante

Esta versão segue a arquitetura atual: HTML/CSS/JavaScript puro, Firebase direto no frontend, GitHub Pages, PWA, Leaflet/OpenStreetMap e Tracker RAFA. Não foi adicionado backend pago nem API paga.
