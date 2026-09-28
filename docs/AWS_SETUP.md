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
