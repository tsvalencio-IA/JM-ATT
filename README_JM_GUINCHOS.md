# JM Guinchos - auditoria profissional

PWA operacional para guinchos e seguradoras, com central de despacho, mapa, rastreamento, painel do motorista, financeiro, equipe, frota, clientes, integrações e pagamentos.

## Acesso inicial

- Painel principal: `jm.html`
- Motorista: `motorista.html`
- Superadmin: `superadmin.html`
- E-mail inicial liberado: `jm@jm.com.br`

Após o primeiro acesso, cadastre os usuários reais em Equipe/Superadmin e remova contas provisórias que não serão usadas em produção.

## Segurança

- O token do rastreador não deve ficar no Git. Cadastre endpoint/token pelo Superadmin.
- O documento público `settings/publicIntegrations` expõe somente configurações necessárias ao app do motorista.
- Regras do Firestore ficam em `firestore.rules` e devem ser publicadas no Firebase antes da operação real.
- Links externos usam proteção contra `window.opener` sempre que possível.
- Exclusões operacionais usam auditoria em `auditLogs`.

## Publicação local ou Railway

```bash
npm start
```

O servidor usa `process.env.PORT` quando disponível, então funciona em Railway/Nixpacks sem build.

## Checklist de produção

1. Publicar `firestore.rules` no Firebase.
2. Ativar autenticação por e-mail/senha no Firebase Authentication.
3. Criar o primeiro superadmin com `jm@jm.com.br`.
4. Configurar Tracker, Cloudinary e mapa no Superadmin.
5. Cadastrar equipe, frota e permissões reais.
6. Testar abertura de rotas, mapa, chamados, fechamento pelo motorista e financeiro.
