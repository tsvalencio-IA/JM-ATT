# Integração automática com seguradoras

Esta base continua compatível com GitHub Pages no frontend. Para receber chamados automaticamente de seguradoras, a arquitetura correta é adicionar uma camada leve que grave documentos em `integrationInbox`.

## Fluxo alvo

1. Seguradora envia acionamento por API/webhook, e-mail estruturado ou portal autorizado.
2. Conector normaliza os dados.
3. Conector grava em `integrationInbox`.
4. Central operacional revisa e converte em chamado.
5. Chamado preserva protocolo, sinistro, apólice, cliente, origem, destino, SLA e texto bruto.

## Documento esperado em `integrationInbox`

```json
{
  "source": "Nome da seguradora",
  "sourceName": "Nome da seguradora",
  "sourceType": "webhook | email_parser | portal_robot | whatsapp | manual",
  "externalId": "id-do-portal-ou-email",
  "protocol": "protocolo externo",
  "customerName": "cliente final",
  "customerPhone": "(17) 99999-9999",
  "payload": {
    "text": "texto bruto recebido",
    "origin": "origem informada",
    "destination": "destino informado",
    "claimNumber": "sinistro",
    "policyNumber": "apólice",
    "customerPlate": "ABC1D23"
  },
  "normalizedCall": {
    "source": "Seguradora",
    "insurance": "Nome da seguradora",
    "insuranceProtocol": "protocolo externo",
    "claimNumber": "sinistro",
    "policyNumber": "apólice",
    "customerName": "cliente final",
    "customerPhone": "(17) 99999-9999",
    "customerPlate": "ABC1D23",
    "originText": "origem informada",
    "destinationText": "destino informado",
    "slaLimitAt": "2026-05-21T12:00",
    "rawText": "texto bruto recebido"
  },
  "status": "novo",
  "createdAt": "ISO_DATE"
}
```

## Opções de conector

- **Webhook/API oficial:** melhor cenário. A seguradora envia JSON direto para uma Cloud Function.
- **E-mail parser:** recebe e-mails de acionamento, extrai campos e grava na fila.
- **Robô autorizado de portal:** só usar com autorização da JM e da plataforma, pois exige credenciais, manutenção e controle de falha.

## Regra de segurança

O frontend não deve carregar senha de portal nem token secreto de seguradora. Esses segredos pertencem ao backend/Cloud Function.
