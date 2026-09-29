# Configuração AWS End User Messaging SMS

## 1. Serviço

Usar **AWS End User Messaging SMS** e a API SMS Voice V2.

O cliente JavaScript utilizado no projeto é:

```ts
@aws-sdk/client-pinpoint-sms-voice-v2
```

O nome do pacote mantém a nomenclatura histórica, mas é o SDK utilizado para a API atual de SMS/Voice V2.

## 2. Região

Valor inicial recomendado para este projeto:

```text
eu-west-1
```

Configurar sempre através de `AWS_REGION`.

## 3. Sandbox

Contas novas começam normalmente no sandbox. No sandbox, os destinos têm de ser verificados e existem limites reduzidos.

Documentação oficial:
https://docs.aws.amazon.com/sms-voice/latest/userguide/sandbox.html

## 4. Origination identity

Criar/obter uma identidade adequada ao caso de uso:

- Sender ID para comunicação unidirecional;
- número/pool quando o caso de uso exigir características que o Sender ID não suporta.

Configurar:

```bash
AWS_SMS_ORIGINATION_IDENTITY=
```

Sender IDs:
https://docs.aws.amazon.com/sms-voice/latest/userguide/sender-id.html

## 5. Configuration Set

Criar um Configuration Set e configurar event destinations para delivery receipts.

```bash
AWS_SMS_CONFIGURATION_SET=
```

Documentação:
https://docs.aws.amazon.com/sms-voice/latest/userguide/configuration-sets.html

## 6. Protect Configuration

Criar uma Protect Configuration e permitir apenas os países necessários. Para um MVP exclusivamente em Portugal, começar por PT.

```bash
AWS_SMS_PROTECT_CONFIGURATION_ID=
```

## 7. IAM

Usar uma IAM Role com menor privilégio. Para a primeira versão, a aplicação precisa de enviar texto através de `sms-voice:SendTextMessage` para a identidade autorizada.

Não usar credenciais administrativas.

## 8. Dry-run

Manter:

```bash
AWS_SMS_DRY_RUN=true
```

até a configuração estar validada.

## 9. Production access e gastos

Antes do lançamento:

- pedir production access para a região;
- aumentar o spending threshold apenas para o volume necessário;
- configurar alarmes de billing;
- configurar rate limiting da aplicação;
- validar regras por país.

Getting started:
https://docs.aws.amazon.com/sms-voice/latest/userguide/getting-started.html

## 10. Delivery receipts

`SendTextMessage` aceite não significa que o telemóvel recebeu a mensagem.

A fase seguinte deve configurar:

```text
AWS End User Messaging SMS
 -> Configuration Set
 -> SNS
 -> SQS (recomendado)
 -> worker da aplicação
 -> atualização de SmsMessage
```

## 11. Checklist de ativação real

- [ ] destino de teste verificado ou production access aprovado
- [ ] origination identity ativa
- [ ] IAM mínimo
- [ ] Protect Configuration
- [ ] Configuration Set
- [ ] limite de gastos
- [ ] consentimento/opt-out testado
- [ ] `SMS_PROVIDER=aws`
- [ ] primeiro teste com `AWS_SMS_DRY_RUN=true`
- [ ] primeiro envio real para número controlado
- [ ] só depois `AWS_SMS_DRY_RUN=false` em produção

## Eventos de entrega (Fase 6) — NÃO executado automaticamente

> Estes comandos criam/alteram recursos reais na AWS. Executar apenas com aprovação explícita,
> na conta e região corretas (`AWS_REGION`, por defeito `eu-west-1`). Nomes são exemplos.

Arquitetura:

```text
SendTextMessage (ConfigurationSetName) → Configuration Set → Event Destination (TEXT_ALL)
  → SNS Topic → HTTPS POST /api/webhooks/aws-sms-events → validação da assinatura → PostgreSQL
```

1. Tópico SNS e política que permite ao serviço publicar:

```bash
aws sns create-topic --name sms-delivery-events --region eu-west-1
# Política do tópico: permitir o principal de serviço "sms-voice.amazonaws.com" fazer sns:Publish,
# com aws:SourceAccount = <conta> (evita confused deputy).
aws sns set-topic-attributes --topic-arn <TOPIC_ARN> --attribute-name Policy --attribute-value file://topic-policy.json
```

2. Configuration Set e destino de eventos (nomes dos parâmetros confirmados no SDK instalado):

```bash
aws pinpoint-sms-voice-v2 create-configuration-set --configuration-set-name sms-app --region eu-west-1
aws pinpoint-sms-voice-v2 create-event-destination \
  --configuration-set-name sms-app \
  --event-destination-name sns-delivery \
  --matching-event-types TEXT_ALL \
  --sns-destination TopicArn=<TOPIC_ARN> \
  --region eu-west-1
```

3. Configurar a aplicação (e fazer deploy com HTTPS público):

```bash
AWS_SMS_CONFIGURATION_SET=sms-app
AWS_SMS_EVENTS_SNS_TOPIC_ARN=<TOPIC_ARN>
```

4. Subscrever o endpoint (a aplicação confirma a subscrição automaticamente, só para o tópico
   configurado e só para URLs `https://sns.<região>.amazonaws.com`):

```bash
aws sns subscribe --topic-arn <TOPIC_ARN> --protocol https \
  --notification-endpoint https://<domínio>/api/webhooks/aws-sms-events --region eu-west-1
```

IAM: receber eventos não requer permissões novas na aplicação. Com Configuration Set, a política
de `sms-voice:SendTextMessage` deve incluir também o ARN do Configuration Set em `Resource`
(verificar na referência de autorização do serviço antes de aplicar).

Segurança do endpoint: sem sessão; aceita só mensagens com assinatura SNS válida (certificado
descarregado de `sns.<região>.amazonaws.com`), do tópico configurado e com menos de 1 h (replay).
Mensagens repetidas são ignoradas (MessageId SNS único). O payload nunca é registado nos logs.

Alternativa mais robusta com tudo na AWS: SNS → SQS → worker (reutiliza `parseSmsEvent` e
`PrismaSmsDeliveryEventHandler`).
