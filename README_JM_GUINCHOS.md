# JM Guinchos V16 - refino SaaS para guincho, seguradoras e operação 24h

Esta entrega consolida a V15 como `JM-GUINCHOS-v16-refino-saas-guincho-seguradoras`.

Leia também `ENTREGA_V16.md` para lista de arquivos alterados, checklist por perfil, instruções de Firestore, cache/PWA e roteiro de teste real.

Esta versão mantém o sistema em frontend estático/GitHub Pages, mas separa melhor os papéis:

- Dono/admin do `jm.html`: `jm@jm.com`.
- Superadmin técnico: `tsvalencio@gmail.com`.
- O superadmin configura integrações, tracker, Cloudinary e base inicial.
- O admin/dono no `jm.html` cadastra, edita e remove motorista, gerente, atendente e financeiro.
- O admin/dono pode editar e excluir chamados.
- O token do rastreador não fica mais hardcoded no `js/config.firebase.js`.
- Chamados, financeiro, despesas, manutenção e equipe passam a ter exclusão operacional com auditoria em `auditLogs`.
- Motorista não visualiza valor/lucro do chamado e envia relatório/checklist/foto para a central.
- Central Operacional ganha filtros por status, prioridade, seguradora, motorista e veículo.
- `formulario.html` foi adicionado para a gestora responder o briefing operacional antes da próxima lapidação.
- O `jm.html` ganhou abas de Clientes / Seguradoras, Integrações e Pagamentos.
- Chamados com rota OSRM agora salvam geometria compatível com Firestore, sem arrays aninhados.

## Publicação Obrigatória

1. Suba todos os arquivos desta pasta.
2. Publique o conteúdo de `firestore.rules` no Firebase Console.
3. Ative login Email/Senha no Firebase Authentication.
4. Abra `superadmin.html?v=jm-v18-provas-assinatura-seguradoras`.
5. Entre/crie o primeiro superadmin com `tsvalencio@gmail.com`.
6. Em Tracker, salve:
   - plataforma: `https://gps2.rafacarrastreadores.com.br`
   - endpoint: `https://gps2.rafacarrastreadores.com.br/api`
   - socket: `wss://gps2.rafacarrastreadores.com.br/api/socket`
   - header: `Authorization`
   - prefixo: `Bearer `
   - polling: `30000` ou maior
7. Em Rastreadores da frota, informe o `deviceId` ou `uniqueId` real do Traccar para a placa correta.
8. Clique em `Criar base JM` e depois em `Sincronizar Tracker`.
9. Abra `jm.html?v=jm-v18-provas-assinatura-seguradoras` e entre com `jm@jm.com`.

## Device Trackar Validado

Com o token fornecido, a API respondeu em `GET /api/devices` e `GET /api/positions` usando `Authorization: Bearer`.
O dispositivo retornado pela API tem `deviceId` 81 e `uniqueId` terminando em `70093`.

O sistema agora avisa quando uma posição foi sincronizada sem vínculo com placa. Nesse caso, coloque `81` ou o `uniqueId` completo no campo da placa correta no superadmin.

## Segurança

O token informado no chat deve ser considerado exposto. Para operação profissional, gere outro token na plataforma de rastreamento antes da publicação.

Como este projeto ainda roda em frontend estático, qualquer token salvo no app pode ser lido por usuários autenticados com acesso ao painel. A evolução profissional correta é mover a chamada ao Trackar para uma Cloud Function ou backend proxy.

Integração automática com sites de seguradoras exige autorização e camada técnica própria. O painel já tem a fila `integrationInbox` para receber acionamentos externos, mas o conector real deve ser API/webhook oficial, e-mail parser autorizado, Cloud Function ou robô autorizado. Não trate raspagem improvisada do navegador como solução profissional.

Ao excluir um funcionário no `jm.html`, o app desativa o cadastro operacional, grava auditoria e remove as permissões em `managerAccess`/`driverAccess`. A conta do Firebase Authentication só pode ser apagada com Admin SDK, Cloud Function ou manualmente no Console Firebase.

## Verificação Local

Execute:

```bash
npm run check:js
```


## v14 - Rotas OSM/OSRM em tempo real, sem API paga

Esta versão mantém Leaflet/OpenStreetMap e adiciona cálculo de rota por ruas/rodovias usando OSRM público. O tracker RAFA continua alimentando a posição real da frota; quando o mapa é renderizado, a rota passa a ser desenhada pela malha viária quando o OSRM responde. Se o serviço gratuito estiver indisponível, o sistema mantém fallback estimado para não quebrar o atendimento.

Fluxo novo do chamado:

1. Informe origem e destino por coordenadas ou por link que contenha coordenadas visíveis.
2. Opcionalmente cole o link externo compartilhado do Google Maps/Waze no campo "Link externo da rota compartilhada".
3. Clique em "Ler/salvar link da rota". Se o link tiver coordenadas visíveis, o sistema preenche origem/destino e calcula rota interna por OSM/OSRM.
4. O botão "Abrir rota no Maps" continua abrindo navegação externa.
5. O mapa interno continua acompanhando a frota em tempo real pelo tracker e recalcula a geometria da rota quando o veículo muda de posição.

Observação técnica: links curtos como `https://maps.app.goo.gl/...` normalmente não expõem coordenadas diretamente no texto do link. Eles são salvos e abertos externamente, mas o desenho interno preciso depende de origem/destino com coordenadas ou de um link completo que mostre coordenadas.

Arquivos alterados na v14:

- `jm.html`
- `motorista.html`
- `css/style.css`
- `js/utils.js`
- `js/google-maps.js`
- `js/mapa.js`
- `js/app.js`
- `js/motorista.js`
- `service-worker.js`
- `README_JM_GUINCHOS.md`
- `DEVTOOLS_TEST_JM_GUINCHOS.js`

## JM Guinchos v16 — Central Operacional para seguradoras e assistências

Esta versão evolui o sistema para um modelo de central de despacho profissional, inspirado em sistemas de pátio/guincho, mas mantendo a arquitetura barata do projeto: GitHub Pages, Firebase, Leaflet/OpenStreetMap, OSRM gratuito e Tracker RAFA.

Principais recursos adicionados:

- Nova aba **Central Operacional** no `jm.html`.
- Mapa vivo de despacho com frota em tempo real.
- Lista de chamados ativos com filtros operacionais.
- Lista de frota online/atrasada/sem GPS.
- Seleção de chamado e veículo no mapa.
- Botão **Despachar veículo selecionado**.
- Botão **Abrir rota**.
- Botão **Copiar link da rota** para WhatsApp/seguradora.
- Fluxo de status profissional: Aguardando Despacho, Despachado, Em Rota, No Local, Em Transporte, Finalizado e Cancelado.
- Campos de atendimento para seguradora/assistência:
  - origem comercial;
  - prioridade/SLA;
  - seguradora/assistência;
  - protocolo externo;
  - sinistro/apólice;
  - placa do cliente;
  - veículo do cliente;
  - excedente KM.

A v16 não remove a V14. As rotas por ruas/rodovias continuam usando OSM/OSRM sem API paga. O link compartilhado do Google Maps/Waze continua sendo salvo como link externo para navegação.

Versão de cache/PWA:

```txt
jm-v18-provas-assinatura-seguradoras
```
