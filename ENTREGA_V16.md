# JM-GUINCHOS-v16-refino-saas-guincho-seguradoras

## Resumo objetivo

Esta versão consolida a V15 em uma V16 profissional sem trocar a arquitetura base. Foram preservados HTML/CSS/JavaScript puro, Firebase no frontend, Firestore, GitHub Pages, PWA, Leaflet/OpenStreetMap, OSRM gratuito e Tracker RAFA.

Principais melhorias:

- Perfis separados no frontend e nas regras Firestore: superadmin, gestor/dono, gerente, financeiro, atendente/auxiliar e motorista.
- Login de motorista criado pelo `jm.html` preservado via Auth secundário, `users/{uid}` e `driverAccess/{email}`.
- Chamados com `statusKey` canônico sem remover o campo legado `status`.
- Central operacional com filtros por status, prioridade, seguradora, motorista e veículo.
- SLA visível na fila operacional e status de cobrança no chamado.
- Motorista sem valor previsto/lucro, com fluxo operacional por etapa e envio de relatório/checklist/foto.
- Financeiro com edição, exclusão lógica auditada, vínculos com chamado, veículo e motorista.
- Cadastro de clientes, seguradoras e parceiros para vincular chamados, faturamento e regras de cobrança.
- Aba de pagamentos para contas a receber/pagar de clientes e seguradoras, usando `transactions` com campos de cobrança.
- Fila `integrationInbox` para entrada profissional de acionamentos externos antes de virar chamado.
- `formulario.html` para a gestora responder o briefing operacional e orientar a próxima lapidação do SaaS.
- Correção da gravação de rota no Firestore: geometria OSRM deixou de usar arrays aninhados, evitando o erro `Nested arrays are not supported`.
- Frota com trackerId/deviceId, última posição, GPS atrasado, manutenção, custo e resultado restrito a perfis financeiros.
- Auditoria em `auditLogs` para exclusões importantes.
- Cache PWA atualizado para V16.

## Arquivos alterados

- `jm.html`
- `motorista.html`
- `superadmin.html`
- `index.html`
- `css/style.css`
- `js/app.js`
- `js/motorista.js`
- `js/utils.js`
- `js/mapa.js`
- `js/tracker.js`
- `firestore.rules`
- `service-worker.js`
- `README_JM_GUINCHOS.md`
- `DEVTOOLS_TEST_JM_GUINCHOS.js`
- `ENTREGA_V16.md`
- `formulario.html`

## O que foi preservado

- Estrutura estática compatível com GitHub Pages.
- Firebase Auth e Firestore no frontend.
- PWA/service worker.
- Leaflet/OpenStreetMap e OSRM gratuito.
- Tracker RAFA/Trackar sem API paga.
- Campos antigos de chamados, frota, usuários, despesas e financeiro.
- Compatibilidade com documentos antigos que não possuem campos novos.

## Limites reais

- Exclusão real de conta no Firebase Authentication não é possível com segurança em frontend puro. A V16 remove o acesso operacional (`managerAccess`/`driverAccess`) e desativa o usuário no painel; a exclusão do Auth fica para Console Firebase, Admin SDK ou Cloud Function.
- Se o Tracker RAFA bloquear CORS/preflight no navegador, o frontend mostra mensagem clara. A solução profissional definitiva é proxy/Cloud Function, documentada como evolução futura porque esta fase não usa backend obrigatório.
- Integração automática com sites de seguradoras não deve ser feita por raspagem improvisada no navegador. A V16 criou a fila `integrationInbox`; o conector real deve ser webhook/API oficial, e-mail parser autorizado, Cloud Function ou robô autorizado com credenciais da JM.
- Upload de fotos depende de Cloudinary configurado no `superadmin.html`.

## Teste real recomendado

1. Publique `firestore.rules` no Firebase Console.
2. Limpe cache do navegador ou abra com `?v=jm-v17-fluxo-unico-financeiro-operacional`.
3. Entre em `superadmin.html` com `tsvalencio@gmail.com`.
4. Salve Tracker, Cloudinary se houver e crie/libere usuários.
5. Entre em `jm.html` com gestor/dono.
6. Crie motorista com senha inicial e teste login em `motorista.html`.
7. Crie chamado com seguradora, protocolo, origem, destino, SLA e motorista.
8. Cadastre uma seguradora em Clientes / Seguradoras e vincule ao chamado.
9. Em Integrações, cole um acionamento recebido por portal/e-mail e gere um chamado a partir da fila.
10. Em Pagamentos, registre conta a receber da seguradora/cliente e confira o financeiro.
11. Na Central Operacional, filtre por prioridade, seguradora, motorista e veículo.
12. Despache veículo, abra rota, copie rota e use WhatsApp.
13. No motorista, altere status, envie relatório/checklist/foto e lance despesa.
14. No financeiro, aprove despesa, edite lançamento e exclua com motivo.
15. Na frota, cadastre trackerId/deviceId, registre manutenção e confira GPS/resultado.
16. Abra `formulario.html` e gere o briefing da gestora.

## Checklist por perfil

- Superadmin: login, criar gestor, criar gerente, criar atendente, criar financeiro, criar motorista, salvar tracker, salvar Cloudinary.
- Gestor/dono: criar/editar/excluir chamado com auditoria, despachar, controlar frota, equipe, financeiro e manutenção.
- Gerente: operar chamados, despachar, cancelar/finalizar e acompanhar frota/manutenção sem controle financeiro total.
- Atendente/auxiliar: criar chamado, preencher seguradora/protocolo/SLA e acompanhar status sem acesso a lucro.
- Financeiro: criar/editar lançamento, aprovar/reprovar despesa e ver relatórios financeiros.
- Motorista: ver apenas seus chamados, abrir rota, mudar status, enviar relatório/foto/checklist e lançar despesa.

## Validação de sintaxe

Com Node disponível, executar na raiz do projeto:

```bash
node --check js/app.js
node --check js/mapa.js
node --check js/motorista.js
node --check js/utils.js
node --check js/google-maps.js
node --check js/firebase.js
node --check js/tracker.js
node --check js/superadmin.js
node --check service-worker.js
```

## Cache/PWA

O cache foi atualizado para `jm-guinchos-fluxo-unico-financeiro-v17`. Após publicar no GitHub Pages, recarregue com Ctrl+F5 ou limpe dados do site se o navegador insistir em arquivos antigos.
