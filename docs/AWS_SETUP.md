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

Com `SMS_JOB_QUEUE=sqs` (secção 12), acrescentar apenas na fila de jobs: `sqs:SendMessage` para
quem publica (aplicação web e `worker:campaigns`) e `sqs:ReceiveMessage`, `sqs:DeleteMessage`,
`sqs:ChangeMessageVisibility` para `worker:sms-jobs` (que também precisa de `sms-voice:SendTextMessage`).
Para a métrica de profundidade da fila (página `/observability` e `/api/metrics`), a aplicação web
precisa de `sqs:GetQueueAttributes` na fila e na DLQ; sem ela a fila aparece como indisponível.

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
- configurar rate limiting da aplicação (`SMS_MPS_PER_ORIGIN`, `SMS_MPS_BY_COUNTRY`) com os MPS da conta;
- rever `SMS_USER_DAILY_PARTS_LIMIT` e os overrides por utilizador: são complementares aos limites de
  gastos da AWS (spend limit e alarmes), que continuam a ser a última barreira;
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

## 12. Fila SQS de envios — NÃO executado automaticamente

> Cria recursos reais. Executar apenas com aprovação explícita, na região `AWS_REGION`.

```bash
# DLQ: mensagens que falharam várias vezes ficam aqui para análise (sem PII no corpo).
aws sqs create-queue --queue-name sms-jobs-dlq --region eu-west-1 \
  --attributes SqsManagedSseEnabled=true,MessageRetentionPeriod=1209600

aws sqs create-queue --queue-name sms-jobs --region eu-west-1 --attributes '{
  "SqsManagedSseEnabled": "true",
  "VisibilityTimeout": "60",
  "ReceiveMessageWaitTimeSeconds": "20",
  "MessageRetentionPeriod": "86400",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"<DLQ_ARN>\",\"maxReceiveCount\":\"5\"}"
}'
```

Política IAM mínima (separar a role do publicador e a do consumidor quando possível):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["sqs:SendMessage"], "Resource": "arn:aws:sqs:eu-west-1:<CONTA>:sms-jobs" },
    {
      "Effect": "Allow",
      "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"],
      "Resource": "arn:aws:sqs:eu-west-1:<CONTA>:sms-jobs"
    }
  ]
}
```

Depois: `SMS_JOB_QUEUE=sqs`, `AWS_SQS_SMS_JOBS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/<CONTA>/sms-jobs`
e correr `pnpm worker:sms-jobs` (mesmo `.env` da aplicação) e `pnpm worker:campaigns`. Alarme
CloudWatch recomendado: `ApproximateNumberOfMessagesVisible` da DLQ > 0.

## 13. Métricas e alarmes — NÃO executado automaticamente

Com `METRICS_EMF=true`, o worker de campanhas publica métricas no namespace `SmsApp` (dimensão
`Mode`) através dos logs — não precisa de permissões `cloudwatch:PutMetricData`. Alarmes sugeridos
(ajustar ao volume):

| Métrica | Condição |
|---|---|
| `DlqVisible` | > 0 |
| `CampaignsPausedWithError` | > 0 |
| `Throttled15m` | > 0 durante 3 períodos |
| `RecipientsStuck` | > 0 durante 2 períodos |
| `ProviderLatencyP95Ms` | > 5000 |

```bash
aws cloudwatch put-metric-alarm --region eu-west-1 --alarm-name sms-dlq-not-empty \
  --namespace SmsApp --metric-name DlqVisible --dimensions Name=Mode,Value=PRODUCTION \
  --statistic Maximum --period 300 --evaluation-periods 1 --threshold 0 \
  --comparison-operator GreaterThanThreshold --alarm-actions <SNS_TOPIC_ARN_ALERTAS>
```

## 14. Script de provisionamento (`pnpm aws:provision`)

Cria os recursos das secções de eventos, 12 e 13 de forma **idempotente** (pode ser repetido; só cria
o que falta). **Por defeito só mostra o plano**; nada é criado sem `--apply`. Nunca apaga nem
substitui recursos, nunca envia SMS e **não** cria nem altera a identidade de origem (Sender ID /
número: registo manual na consola AWS).

```bash
# 1. Ver o plano (só leituras; recusa correr se as credenciais forem de outra conta)
pnpm aws:provision --account 123456789012 --region eu-west-1 \
  --webhook-url https://sms.exemplo.pt/api/webhooks/aws-sms-events \
  --with-sqs --alarm-topic-arn arn:aws:sns:eu-west-1:123456789012:alertas

# 2. Rever e aplicar
pnpm aws:provision --account 123456789012 ... --apply
```

| Recurso | Criado quando | Detalhes |
|---|---|---|
| Protect Configuration | sempre | proteção contra eliminação; **só `--countries` permitido** (defeito `PT`), restantes `BLOCK`; regras corrigidas se divergirem |
| Configuration Set `sms-app` | sempre | Protect Configuration associada |
| Tópico SNS `sms-delivery-events` | sempre | política: só `sms-voice.amazonaws.com` desta conta publica |
| Destino de eventos `sms-app-sns` | sempre | `TEXT_ALL` → SNS; se existir a apontar para outro tópico, **não é alterado** (aviso) |
| Subscrição HTTPS | `--webhook-url` | a aplicação tem de estar publicada **antes**, com `AWS_SMS_EVENTS_SNS_TOPIC_ARN` definido (confirma a subscrição sozinha) |
| Filas `sms-jobs` + `sms-jobs-dlq` | `--with-sqs` | SSE, visibilidade 60 s, DLQ após 5 receções |
| 5 alarmes CloudWatch | `--alarm-topic-arn` | métricas EMF (§13); alarmes existentes não são alterados |

No fim imprime as variáveis a colocar no ambiente da aplicação (`AWS_SMS_CONFIGURATION_SET`,
`AWS_SMS_PROTECT_CONFIGURATION_ID`, `AWS_SMS_EVENTS_SNS_TOPIC_ARN`, filas SQS). Não imprime segredos.

Permissões da identidade **que corre o script** (temporária, separada da aplicação; nunca admin):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "sts:GetCallerIdentity", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": [
        "sms-voice:CreateProtectConfiguration", "sms-voice:DescribeProtectConfigurations",
        "sms-voice:GetProtectConfigurationCountryRuleSet", "sms-voice:UpdateProtectConfigurationCountryRuleSet",
        "sms-voice:CreateConfigurationSet", "sms-voice:DescribeConfigurationSets",
        "sms-voice:AssociateProtectConfiguration", "sms-voice:CreateEventDestination", "sms-voice:TagResource"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["sns:CreateTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:TagResource"],
      "Resource": "arn:aws:sns:eu-west-1:<CONTA>:sms-delivery-events"
    },
    { "Effect": "Allow", "Action": ["sqs:CreateQueue", "sqs:GetQueueUrl", "sqs:TagQueue"], "Resource": "arn:aws:sqs:eu-west-1:<CONTA>:sms-jobs*" },
    { "Effect": "Allow", "Action": ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource"], "Resource": "*" }
  ]
}
```

Se uma execução falhar a meio, os passos concluídos mantêm-se e repetir é seguro (a Protect
Configuration usa um `ClientToken` determinístico, pelo que não é duplicada).

