# CLAUDE.md — Plataforma de envio de SMS via AWS

## 1. Missão do projeto

Construir uma aplicação web segura, simples e preparada para produção para envio e acompanhamento de SMS através do **AWS End User Messaging SMS**.

> Importante: não criar uma nova implementação baseada em Amazon Pinpoint Campaigns/Journeys. O Amazon Pinpoint termina o suporte em 30 de outubro de 2026. Para SMS usar o AWS End User Messaging SMS / SMS Voice V2 API.

A aplicação deve começar como um MVP sólido e evoluir de forma incremental. Em cada alteração, manter o projeto executável, testável e documentado.

Idioma da interface: **Português (Portugal)**.  
Timezone de apresentação: **Europe/Lisbon**.  
Datas na base de dados: **UTC**.

---

## 2. Objetivos funcionais

O MVP deve permitir:

1. Autenticação de utilizadores autorizados.
2. Envio de um SMS individual.
3. Gestão de contactos.
4. Importação de contactos por CSV.
5. Criação e gestão de listas/grupos de contactos.
6. Gestão de templates de SMS.
7. Criação de campanhas para múltiplos destinatários.
8. Validação do consentimento antes do envio.
9. Bloqueio de contactos em opt-out.
10. Histórico de mensagens e respetivo estado.
11. Pesquisa e filtros no histórico.
12. Dashboard com métricas básicas.
13. Configuração segura da integração AWS.
14. Registo de auditoria das ações relevantes.
15. Modo de teste/dry-run sem envio real.
16. Confirmação explícita antes de envios em massa.

Funcionalidades posteriores ao MVP:

- agendamento de campanhas;
- receção de SMS;
- respostas automáticas;
- múltiplas organizações/tenants;
- faturação interna;
- quotas por utilizador;
- webhooks externos;
- API pública;
- exportações avançadas;
- RCS/MMS.

Não implementar funcionalidades posteriores antes de o MVP estar estável.

---

## 3. Stack técnica

Usar, salvo impedimento técnico justificado:

- **Next.js**, versão estável atual, com App Router;
- **TypeScript** com `strict: true`;
- **React**;
- **pnpm**;
- **PostgreSQL**;
- **Prisma ORM**;
- **Zod** para validação;
- **Tailwind CSS** para UI;
- componentes acessíveis e reutilizáveis;
- **AWS SDK for JavaScript v3**;
- pacote AWS:
  `@aws-sdk/client-pinpoint-sms-voice-v2`;
- `libphonenumber-js` para normalização e validação de números;
- testes unitários com Vitest ou equivalente estável;
- Playwright para os principais testes end-to-end.

Não adicionar bibliotecas sem necessidade. Antes de instalar uma dependência, confirmar se a funcionalidade não pode ser resolvida de forma simples com a stack já existente.

---

## 4. Serviço AWS correto

Usar:

**AWS End User Messaging SMS**

A API utilizada é a SMS Voice V2 API.

Apesar do nome histórico do pacote npm, o cliente JavaScript correto é:

```ts
import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
```

Para enviar um SMS:

```ts
const client = new PinpointSMSVoiceV2Client({
  region: process.env.AWS_REGION,
});

const command = new SendTextMessageCommand({
  DestinationPhoneNumber: destinationPhoneNumber,
  OriginationIdentity: process.env.AWS_SMS_ORIGINATION_IDENTITY,
  MessageBody: messageBody,
  MessageType: messageType,
  ConfigurationSetName:
    process.env.AWS_SMS_CONFIGURATION_SET || undefined,
  ProtectConfigurationId:
    process.env.AWS_SMS_PROTECT_CONFIGURATION_ID || undefined,
  DryRun: dryRun,
});

const result = await client.send(command);
```

A função de domínio responsável pelo envio deve devolver uma estrutura normalizada, por exemplo:

```ts
type SmsSendResult =
  | {
      ok: true;
      messageId: string;
      provider: "aws";
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
    };
```

Nunca expor diretamente objetos internos do SDK AWS à camada de UI.

---

## 5. Arquitetura

Separar claramente:

```text
UI
  ↓
Server Actions / API
  ↓
Application services
  ↓
Domain rules
  ↓
Repositories + AWS adapter
  ↓
PostgreSQL / AWS End User Messaging SMS
```

Estrutura sugerida:

```text
src/
  app/
    (auth)/
    (dashboard)/
    api/
  components/
  features/
    auth/
    contacts/
    lists/
    templates/
    campaigns/
    messages/
    settings/
  lib/
    aws/
      sms-client.ts
      sms-service.ts
      sms-errors.ts
    auth/
    db/
    phone/
    sms/
      encoding.ts
      segments.ts
      validation.ts
  server/
    services/
    repositories/
  types/
prisma/
  schema.prisma
tests/
```

Regras:

- código AWS só no servidor;
- acesso à base de dados só no servidor;
- componentes React não devem conhecer detalhes do SDK AWS;
- regras de consentimento e opt-out pertencem à camada de domínio;
- evitar lógica de negócio dentro de componentes UI;
- evitar chamadas AWS diretamente em Route Handlers sem passar por um serviço de aplicação;
- manter funções pequenas, tipadas e testáveis.

---

## 6. Configuração por ambiente

Criar `.env.example` com:

```bash
# Application
NODE_ENV=development
APP_URL=http://localhost:3000
AUTH_SECRET=change-me

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/sms_app

# AWS
AWS_REGION=eu-west-1
AWS_SMS_ORIGINATION_IDENTITY=
AWS_SMS_CONFIGURATION_SET=
AWS_SMS_PROTECT_CONFIGURATION_ID=
AWS_SMS_DEFAULT_MESSAGE_TYPE=TRANSACTIONAL
AWS_SMS_DRY_RUN=true

# Apenas desenvolvimento local, se necessário.
# Em produção usar IAM Role / workload identity e NÃO access keys estáticas.
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Safety limits
SMS_MAX_RECIPIENTS_PER_CAMPAIGN=500
SMS_MAX_SENDS_PER_MINUTE=60
```

Nunca fazer commit de `.env`, chaves AWS ou outros segredos.

Em produção, preferir credenciais temporárias fornecidas por IAM Role em vez de `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY`.

---

## 7. Região AWS

Usar `eu-west-1` como valor inicial recomendado para o projeto, mas nunca hardcode no código.

A região deve vir de `AWS_REGION`.

Todos os recursos relacionados com SMS devem ser configurados na região utilizada pela aplicação.

---

## 8. Configuração necessária na AWS

Antes de considerar o envio real concluído, documentar e validar:

### 8.1 Sandbox

Contas novas de AWS End User Messaging SMS começam normalmente em sandbox.

Enquanto a conta estiver em sandbox:

- só é possível enviar para números de destino verificados;
- existe um limite de até 10 números de destino verificados;
- existe um limite mensal reduzido de gastos para SMS;
- o comportamento serve apenas para desenvolvimento/testes.

Criar uma secção no `README.md` explicando como pedir acesso de produção.

### 8.2 Origination identity

Configurar uma identidade de origem apropriada:

- Sender ID;
- número de telefone;
- pool de números.

Para Portugal, preferir:

- **Sender ID** para comunicação unidirecional com identificação da marca;
- **número de telefone adequado** quando for necessário receber respostas.

Não assumir que um Sender ID aceita respostas.

O `OriginationIdentity` deve ser configurável por variável de ambiente e não deve ser escolhido livremente pelo browser.

### 8.3 Sender ID

Quando usado, respeitar as regras AWS:

- entre 1 e 11 caracteres;
- conter pelo menos uma letra;
- apenas letras, números e hífen;
- não começar nem terminar com hífen;
- manter exatamente o casing aprovado/registado.

### 8.4 Configuration Set

Criar um **Configuration Set** na AWS e usá-lo em todos os envios de produção.

Associar um destino de eventos para obter informação de entrega.

Preferência:

```text
AWS End User Messaging SMS
    ↓
Configuration Set
    ↓
SNS / CloudWatch
    ↓
processamento da aplicação
```

### 8.5 Protect Configuration

Criar uma **Protect Configuration**.

Por defeito, limitar os países de destino aos países efetivamente utilizados pelo negócio.

No primeiro deployment, se a aplicação for apenas para Portugal, configurar o envio apenas para `PT`.

Nunca abrir envio global sem necessidade explícita.

### 8.6 Limites e orçamento

Configurar:

- limites de gastos AWS;
- alarmes CloudWatch/Billing;
- limites internos por campanha;
- rate limiting;
- proteção contra duplicação de envios.

---

## 9. IAM

Aplicar princípio de menor privilégio.

A aplicação que apenas envia SMS deve começar com permissão equivalente a:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sms-voice:SendTextMessage"
      ],
      "Resource": [
        "ARN_DA_ORIGINATION_IDENTITY_AUTORIZADA"
      ]
    }
  ]
}
```

Se forem necessários outros recursos, adicionar permissões individualmente e documentar o motivo.

Evitar:

```json
"Action": "*",
"Resource": "*"
```

Nunca colocar permissões administrativas AWS na aplicação.

---

## 10. Regras de números de telefone

Internamente, todos os números devem ser guardados em formato **E.164**.

Exemplo:

```text
+351912345678
```

Usar `libphonenumber-js`.

No formulário:

- aceitar formatos introduzidos pelo utilizador;
- assumir `PT` como país visual predefinido, sem forçar esse país;
- converter para E.164;
- rejeitar números impossíveis/inválidos;
- mostrar ao utilizador o número normalizado antes do envio em massa.

Nunca usar apenas regex para validar números internacionais.

---

## 11. Tipos de mensagem

Suportar explicitamente:

```ts
type SmsMessageType = "TRANSACTIONAL" | "PROMOTIONAL";
```

### TRANSACTIONAL

Exemplos:

- códigos;
- alertas;
- confirmações;
- atualizações de serviço;
- informação solicitada pelo utilizador.

### PROMOTIONAL

Exemplos:

- campanhas de marketing;
- promoções;
- publicidade;
- ofertas.

Não converter automaticamente uma mensagem promocional em transacional para contornar regras, preços, horários ou restrições.

A UI deve obrigar o operador a selecionar o tipo da mensagem.

---

## 12. Consentimento e opt-out

Esta regra é crítica.

Nunca enviar uma campanha para um contacto se:

```text
consentStatus != OPTED_IN
```

ou se:

```text
optedOutAt != null
```

Registar para cada consentimento:

- data/hora;
- origem;
- finalidade;
- texto/versão do consentimento quando aplicável;
- utilizador/processo que o registou.

Estados sugeridos:

```ts
type ConsentStatus =
  | "UNKNOWN"
  | "OPTED_IN"
  | "OPTED_OUT";
```

A aplicação deve manter uma suppression list local além das proteções do fornecedor.

Antes de cada envio:

1. normalizar número;
2. procurar contacto;
3. verificar opt-out local;
4. verificar consentimento;
5. verificar tipo de mensagem;
6. verificar limites;
7. só depois chamar a AWS.

Nunca oferecer opção de ignorar opt-out na UI.

---

## 13. Privacidade e RGPD

Projetar assumindo que os números de telefone são dados pessoais.

Requisitos:

- recolher apenas os dados necessários;
- manter registo do fundamento/consentimento aplicável;
- permitir eliminação ou anonimização de dados quando legalmente adequado;
- restringir acesso por perfil;
- não colocar números completos em logs técnicos desnecessários;
- mascarar números em logs, por exemplo:
  `+351******678`;
- evitar colocar conteúdo completo de mensagens em logs de aplicação;
- definir política de retenção;
- registar ações administrativas;
- não exportar listas de contactos sem autorização.

Nunca enviar contactos, mensagens ou credenciais para serviços externos sem necessidade explícita.

---

## 14. Limites de caracteres e partes SMS

Criar um contador de caracteres e uma estimativa de partes antes do envio.

A AWS usa SMS em partes:

### GSM 03.38

- 1 parte: até 160 caracteres;
- multipart: aproximadamente 153 caracteres úteis por parte.

### Unicode / fora de GSM 03.38

- 1 parte: até 70 caracteres;
- multipart: aproximadamente 67 caracteres úteis por parte.

A AWS cobra por parte de mensagem.

O tamanho máximo suportado pela AWS deve ser validado antes do envio:

- até 1530 caracteres GSM;
- até 630 caracteres quando é necessário encoding não-GSM.

A API pode aceitar um `MessageBody` maior em termos de schema, mas a aplicação deve aplicar os limites reais de SMS antes de tentar enviar.

Criar:

```ts
type SmsSegmentInfo = {
  encoding: "GSM_7" | "UCS_2";
  characters: number;
  segments: number;
  remainingInSegment: number;
};
```

A função de cálculo deve ter testes extensivos, incluindo caracteres portugueses e caracteres GSM de extensão como:

```text
^ { } \ [ ] ~ | €
```

Estes caracteres podem contar como dois septets em GSM 03.38.

Na UI, indicar que o valor é uma estimativa.

---

## 15. Modelo de dados

Criar os modelos de domínio seguintes, adaptando nomes se necessário.

### User

```text
id
name
email
role
createdAt
updatedAt
```

Roles:

```text
ADMIN
OPERATOR
VIEWER
```

### Contact

```text
id
name
phoneE164 UNIQUE
email OPTIONAL
consentStatus
consentAt OPTIONAL
consentSource OPTIONAL
optedOutAt OPTIONAL
notes OPTIONAL
createdAt
updatedAt
```

### ContactList

```text
id
name
description OPTIONAL
createdAt
updatedAt
```

### ContactListMember

```text
listId
contactId
createdAt
```

Unique composto:

```text
(listId, contactId)
```

### SmsTemplate

```text
id
name
body
messageType
createdById
createdAt
updatedAt
```

### Campaign

```text
id
name
status
messageType
templateId OPTIONAL
messageBody
scheduledAt OPTIONAL
startedAt OPTIONAL
finishedAt OPTIONAL
createdById
createdAt
updatedAt
```

Status:

```text
DRAFT
READY
SENDING
COMPLETED
PARTIAL
CANCELLED
FAILED
```

### CampaignRecipient

```text
id
campaignId
contactId
messageId OPTIONAL
status
errorCode OPTIONAL
errorMessage OPTIONAL
createdAt
updatedAt
```

Unique composto:

```text
(campaignId, contactId)
```

### SmsMessage

```text
id
awsMessageId OPTIONAL
campaignId OPTIONAL
contactId OPTIONAL
destinationPhoneE164
messageType
body
encodingEstimate OPTIONAL
segmentCountEstimate OPTIONAL
status
provider
errorCode OPTIONAL
errorMessage OPTIONAL
sentAt OPTIONAL
deliveredAt OPTIONAL
failedAt OPTIONAL
createdById
createdAt
updatedAt
```

Estados possíveis:

```text
PENDING
ACCEPTED
QUEUED
SENT
DELIVERED
FAILED
UNROUTABLE
PROTECT_BLOCKED
UNKNOWN
CANCELLED
```

Não assumir que a resposta imediata da API significa `DELIVERED`.

### AuditLog

```text
id
userId OPTIONAL
action
entityType
entityId OPTIONAL
metadataJson
ipAddress OPTIONAL
createdAt
```

Não guardar secrets em `metadataJson`.

---

## 16. Envio individual

Criar página:

```text
/send
```

Campos:

- destinatário;
- mensagem;
- tipo `TRANSACTIONAL` / `PROMOTIONAL`;
- indicação de encoding;
- contador de caracteres;
- estimativa de partes;
- modo dry-run quando permitido.

Fluxo:

1. utilizador preenche;
2. validar Zod;
3. normalizar E.164;
4. validar consentimento quando o número pertence a contacto conhecido;
5. verificar opt-out;
6. calcular partes;
7. mostrar resumo;
8. pedir confirmação;
9. criar `SmsMessage` como `PENDING`;
10. chamar serviço AWS;
11. guardar `awsMessageId`;
12. mudar para `ACCEPTED` quando a chamada for aceite;
13. mostrar resultado;
14. registar auditoria.

Para números sem contacto conhecido, exigir confirmação de que existe base legal/consentimento antes de permitir envio promocional.

---

## 17. Campanhas

Uma campanha nunca deve executar todos os envios dentro de um único request HTTP longo.

Para o MVP:

- criar a campanha;
- resolver a lista de destinatários;
- criar `CampaignRecipient`;
- processar em lotes controlados;
- respeitar rate limits;
- permitir retoma segura;
- usar idempotência.

Em produção, preparar a abstração para uma fila, preferencialmente **Amazon SQS**.

Interface recomendada:

```ts
interface SmsJobQueue {
  enqueue(job: SendSmsJob): Promise<void>;
}
```

Implementações:

```text
DirectSmsJobQueue     -> desenvolvimento/MVP controlado
SqsSmsJobQueue        -> produção
```

A camada de domínio não deve depender diretamente do SQS.

Nunca reenviar automaticamente uma mensagem cujo resultado seja incerto sem verificar idempotência e estado.

---

## 18. Idempotência

Todos os envios devem ter uma chave interna de idempotência.

Exemplo:

```text
campaignId + contactId
```

ou:

```text
manual-send UUID
```

Antes do envio, confirmar que a mesma operação não foi concluída anteriormente.

Adicionar constraints de base de dados quando possível.

O objetivo é evitar SMS duplicados em:

- refresh do browser;
- retries;
- timeouts;
- jobs repetidos;
- deploy/restart do worker.

---

## 19. Rate limiting

Não assumir um throughput fixo da AWS.

Os limites são medidos em **Message Parts per Second (MPS)** e dependem do país e da identidade de origem.

Implementar um limite interno configurável.

Primeira versão:

```text
SMS_MAX_SENDS_PER_MINUTE
```

Versão posterior:

- token bucket;
- limite por origination identity;
- limite por país;
- limite por utilizador;
- limite por campanha;
- adaptação a throttling AWS.

Se a AWS responder com throttling, usar retry com exponential backoff e jitter apenas quando for seguro.

---

## 20. Tratamento de erros AWS

Criar um adaptador que traduza erros AWS para erros internos.

Exemplo:

```ts
type SmsProviderError =
  | "VALIDATION_ERROR"
  | "INVALID_PHONE_NUMBER"
  | "OPTED_OUT"
  | "THROTTLED"
  | "SPEND_LIMIT"
  | "PROTECT_BLOCKED"
  | "AUTH_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";
```

Nunca mostrar stack traces ou detalhes de credenciais ao utilizador.

Guardar:

- código normalizado;
- mensagem segura;
- nome do erro AWS quando útil;
- request correlation id quando disponível.

Definir `retryable` explicitamente.

Não fazer retries de:

- número inválido;
- opt-out;
- erro de consentimento;
- bloqueio de proteção;
- validação.

---

## 21. Delivery status

A resposta de `SendTextMessage` representa aceitação do pedido, não entrega final ao dispositivo.

Usar `ConfigurationSetName` e configurar Event Destinations.

A AWS pode emitir estados como:

```text
ACCEPTED
QUEUED
SENT
DELIVERED
FAILED
UNROUTABLE
PROTECT_BLOCKED
UNKNOWN
```

Criar um serviço:

```ts
interface SmsDeliveryEventHandler {
  handle(event: SmsDeliveryEvent): Promise<void>;
}
```

Os eventos devem atualizar `SmsMessage` através do `awsMessageId`.

Processamento de evento deve ser idempotente.

Não assumir ordenação perfeita dos eventos.

Não assumir que a ausência imediata de um delivery receipt representa falha; recibos de operadores podem demorar.

---

## 22. Integração SNS para eventos

Quando for implementada atualização de estado em tempo real, preferir:

```text
AWS End User Messaging SMS
  -> Configuration Set
  -> SNS Topic
  -> consumidor seguro
  -> PostgreSQL
```

Se o consumidor for HTTP:

- validar mensagens SNS;
- validar assinatura;
- não confiar no payload sem validação;
- suportar confirmação de subscrição de forma segura;
- proteger contra replay;
- manter endpoint idempotente.

Se a infraestrutura já estiver toda em AWS, considerar:

```text
SNS -> SQS -> worker
```

para maior robustez.

---

## 23. Contactos e importação CSV

Página:

```text
/contacts
```

Importação CSV deve:

1. apresentar preview;
2. permitir mapear colunas;
3. normalizar números;
4. validar E.164;
5. identificar duplicados;
6. rejeitar linhas inválidas;
7. não marcar consentimento automaticamente;
8. apresentar relatório final.

Nunca interpretar a simples presença de um número num CSV como consentimento para marketing.

Formato recomendado:

```csv
name,phone,consent_status,consent_source
Maria,+351912345678,OPTED_IN,website
Joao,+351913456789,UNKNOWN,legacy-import
```

---

## 24. Templates

Página:

```text
/templates
```

Suportar variáveis simples, por exemplo:

```text
Olá {{firstName}}, a sua marcação é no dia {{date}} às {{time}}.
```

Usar uma whitelist explícita de variáveis.

Nunca executar templates como JavaScript.

Nunca usar `eval`.

Quando uma variável estiver em falta:

- bloquear envio;
- mostrar erro;
- indicar contacto/campo em falta.

Não enviar texto com placeholders não resolvidos.

---

## 25. Dashboard

Página:

```text
/dashboard
```

Mostrar, pelo menos:

- SMS enviados hoje;
- SMS enviados no mês;
- entregues;
- falhados;
- pendentes/desconhecidos;
- total de contactos;
- contactos em opt-out;
- campanhas recentes.

Quando os dados de entrega ainda não estiverem configurados, distinguir:

```text
ACEITE PELA AWS
```

de:

```text
ENTREGUE
```

Nunca apresentar `ACCEPTED` como `DELIVERED`.

---

## 26. Histórico

Página:

```text
/messages
```

Colunas:

- data/hora;
- contacto;
- telefone mascarado;
- tipo;
- campanha;
- partes estimadas;
- estado;
- AWS Message ID;
- operador.

Filtros:

- data;
- estado;
- campanha;
- tipo;
- contacto.

Permitir abrir detalhes, mas aplicar permissões.

---

## 27. Autenticação e autorização

A aplicação não deve ter registo público de utilizadores no MVP.

Perfis:

### ADMIN

- gerir utilizadores;
- configurar aplicação;
- gerir contactos;
- criar e enviar campanhas;
- ver logs;
- exportar dados.

### OPERATOR

- gerir contactos;
- criar templates;
- criar campanhas;
- enviar SMS;
- ver histórico.

### VIEWER

- apenas leitura.

Todas as verificações importantes devem acontecer no servidor.

Nunca confiar numa role enviada pelo browser.

---

## 28. Segurança

Obrigatório:

- TypeScript strict;
- validação Zod no servidor;
- cookies de sessão `HttpOnly`, `Secure` em produção e `SameSite` adequado;
- proteção CSRF conforme o mecanismo de autenticação;
- rate limiting;
- headers de segurança;
- controlo de acesso no servidor;
- SQL apenas através do ORM salvo motivo documentado;
- escaping correto;
- sem `eval`;
- sem secrets no cliente;
- sem AWS SDK de envio no browser;
- sem logging de passwords/tokens/keys;
- dependências atualizadas e auditadas;
- mensagens de erro seguras;
- confirmação explícita para campanhas;
- audit log para ações sensíveis.

A UI nunca deve receber:

- AWS secret key;
- session secrets;
- database URL;
- credenciais internas;
- política IAM completa com dados sensíveis.

---

## 29. Fluxo de confirmação de campanha

Antes de iniciar uma campanha apresentar:

```text
Campanha: <nome>
Tipo: TRANSACTIONAL | PROMOTIONAL
Destinatários elegíveis: N
Excluídos por opt-out: N
Sem consentimento: N
Números inválidos: N
Partes SMS estimadas: N
Origem: <sender/pool mascarado>
Modo: TESTE | PRODUÇÃO
```

Botão final:

```text
Confirmar e enviar
```

Para volumes acima de um threshold configurável, pedir uma segunda confirmação textual, por exemplo:

```text
ENVIAR 250 SMS
```

Nunca iniciar campanha em massa apenas ao guardar o formulário.

---

## 30. Dry-run

Implementar `AWS_SMS_DRY_RUN=true`.

Em ambiente local:

- por defeito `true`;
- permitir testes sem envio real.

A UI deve mostrar claramente:

```text
MODO DE TESTE — nenhum SMS real será enviado
```

Em produção, o valor deve ser explícito.

Não assumir `false` quando a variável não existe. Preferir falhar de forma segura ou usar `true`.

---

## 31. Logging

Usar logging estruturado.

Campos úteis:

```text
event
messageInternalId
awsMessageId
campaignId
userId
status
durationMs
errorCode
```

Mascarar telefone.

Não incluir por defeito:

- corpo completo da mensagem;
- credentials;
- session tokens;
- database URL;
- conteúdo sensível.

---

## 32. Observabilidade

Preparar:

- logs estruturados;
- métricas de envio;
- número de sucessos/falhas;
- throttling;
- latência do provider;
- campanhas em erro;
- queue depth quando houver SQS.

Criar health endpoint sem informação sensível:

```text
GET /api/health
```

Resposta exemplo:

```json
{
  "status": "ok"
}
```

Não testar envio real no health check.

---

## 33. Testes

Não considerar uma funcionalidade concluída sem testes adequados.

### Unit tests

Cobrir:

- normalização E.164;
- números inválidos;
- opt-out;
- consentimento;
- cálculo de segmentos;
- GSM 03.38;
- Unicode;
- templates;
- idempotência;
- mapeamento de erros AWS.

### Integration tests

Cobrir:

- criação de contacto;
- importação;
- envio em dry-run;
- persistência de `SmsMessage`;
- campanhas;
- autorização.

Mockar o adapter AWS.

Não chamar AWS real na suite normal.

### E2E

Cobrir pelo menos:

1. login;
2. criar contacto;
3. criar template;
4. enviar SMS em dry-run;
5. consultar histórico;
6. criar campanha;
7. confirmar campanha;
8. verificar bloqueio de opt-out.

---

## 34. Estratégia de mocks

Definir interface:

```ts
export interface SmsProvider {
  send(input: SendSmsInput): Promise<SmsSendResult>;
}
```

Implementações:

```text
AwsSmsProvider
FakeSmsProvider
```

`FakeSmsProvider` deve permitir:

- sucesso;
- falha;
- throttling;
- opt-out;
- atraso simulado.

Isto permite desenvolver toda a aplicação antes de a conta AWS estar pronta para produção.

---

## 35. UX

Princípios:

- interface limpa;
- português de Portugal;
- desktop-first, mas responsiva;
- ações destrutivas claramente identificadas;
- estados de loading;
- erros acionáveis;
- feedback de sucesso;
- tabelas paginadas;
- pesquisa;
- filtros persistentes quando útil;
- acessibilidade básica WCAG.

Evitar dashboards visualmente carregados.

Priorizar clareza operacional.

---

## 36. Ordem de implementação

Claude Code deve desenvolver nesta ordem.

### Fase 0 — Bootstrap

1. Inspecionar o repositório.
2. Se estiver vazio, criar Next.js + TypeScript.
3. Configurar pnpm.
4. Configurar lint e format.
5. Criar `.env.example`.
6. Criar PostgreSQL/Prisma.
7. Criar README inicial.
8. Garantir `pnpm lint`, `pnpm typecheck` e testes.

### Fase 1 — Fundação

1. autenticação;
2. autorização;
3. layout;
4. base de dados;
5. audit log;
6. validações partilhadas.

### Fase 2 — Contactos

1. CRUD;
2. E.164;
3. consentimento;
4. opt-out;
5. listas;
6. importação CSV.

### Fase 3 — SMS provider

1. interface `SmsProvider`;
2. `FakeSmsProvider`;
3. `AwsSmsProvider`;
4. envio individual;
5. dry-run;
6. error mapping;
7. logs.

### Fase 4 — Templates

1. CRUD;
2. variáveis;
3. preview;
4. validação.

### Fase 5 — Campanhas

1. draft;
2. selecionar lista;
3. resolver elegibilidade;
4. preview;
5. confirmação;
6. processamento por lotes;
7. idempotência;
8. progresso.

### Fase 6 — Delivery events

1. Configuration Set;
2. SNS/SQS ou endpoint;
3. ingestão;
4. atualização de estados;
5. métricas.

### Fase 7 — Hardening

1. rate limits;
2. security review;
3. performance;
4. acessibilidade;
5. retention;
6. testes E2E;
7. documentação de deployment.

Não avançar várias fases deixando testes ou tipos quebrados.

---

## 37. Definition of Done

Uma tarefa só está concluída quando:

- código compila;
- TypeScript não tem erros;
- lint passa;
- testes relevantes passam;
- migrações estão incluídas;
- `.env.example` está atualizado;
- nenhum secret foi adicionado ao git;
- UI trata loading/error/empty states;
- permissões foram testadas;
- erros AWS são tratados;
- documentação foi atualizada;
- funcionalidade pode ser demonstrada em dry-run.

---

## 38. Comandos obrigatórios antes de concluir alterações

Executar os scripts disponíveis equivalentes a:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Se existir suite E2E e o ambiente suportar:

```bash
pnpm test:e2e
```

Se algum comando falhar:

- corrigir;
- voltar a executar;
- não declarar a tarefa concluída com erros conhecidos.

---

## 39. Regras de trabalho para Claude Code

Ao iniciar qualquer sessão:

1. Ler este `CLAUDE.md`.
2. Ler `README.md`.
3. Inspecionar `package.json`.
4. Inspecionar `prisma/schema.prisma`, se existir.
5. Inspecionar alterações git existentes antes de editar.
6. Não apagar trabalho existente sem necessidade.
7. Fazer alterações pequenas e coerentes.
8. Não reestruturar ficheiros não relacionados.
9. Explicar alterações relevantes no final.
10. Listar comandos de validação executados.
11. Indicar claramente qualquer item que não tenha sido testado.
12. Não inventar APIs de bibliotecas; consultar tipos/documentação instalada quando necessário.
13. Preferir código simples a abstrações prematuras.
14. Não adicionar TODOs críticos como substituto de implementação.
15. Não fazer deploy nem operações destrutivas AWS sem instrução explícita.

---

## 40. Regras críticas de segurança de envio

Estas regras não podem ser removidas para acelerar desenvolvimento:

```text
NO client-side AWS credentials
NO automatic opt-in
NO bypass de opt-out
NO silent bulk send
NO wildcard admin IAM credentials
NO secrets in git
NO retries cegos
NO duplicate sends
NO promotional send without consent/legal basis
NO production send by default in local development
```

---

## 41. Componente de envio AWS

Implementar algo equivalente a:

```ts
import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";

export type SendSmsInput = {
  destinationPhoneNumber: string;
  messageBody: string;
  messageType: "TRANSACTIONAL" | "PROMOTIONAL";
  dryRun?: boolean;
  context?: Record<string, string>;
};

export class AwsSmsProvider {
  private readonly client: PinpointSMSVoiceV2Client;

  constructor() {
    const region = process.env.AWS_REGION;

    if (!region) {
      throw new Error("AWS_REGION is required");
    }

    this.client = new PinpointSMSVoiceV2Client({ region });
  }

  async send(input: SendSmsInput) {
    const originationIdentity =
      process.env.AWS_SMS_ORIGINATION_IDENTITY;

    if (!originationIdentity) {
      throw new Error(
        "AWS_SMS_ORIGINATION_IDENTITY is required",
      );
    }

    const command = new SendTextMessageCommand({
      DestinationPhoneNumber: input.destinationPhoneNumber,
      OriginationIdentity: originationIdentity,
      MessageBody: input.messageBody,
      MessageType: input.messageType,
      ConfigurationSetName:
        process.env.AWS_SMS_CONFIGURATION_SET || undefined,
      ProtectConfigurationId:
        process.env.AWS_SMS_PROTECT_CONFIGURATION_ID || undefined,
      DryRun:
        input.dryRun ??
        process.env.AWS_SMS_DRY_RUN !== "false",
      Context: input.context,
    });

    const response = await this.client.send(command);

    return {
      ok: true as const,
      messageId: response.MessageId!,
      provider: "aws" as const,
    };
  }
}
```

Este snippet é apenas ponto de partida.

Antes de o usar em produção:

- validar input;
- normalizar erros;
- adicionar logging seguro;
- persistir idempotência;
- aplicar consentimento;
- aplicar opt-out;
- aplicar rate limiting;
- criar testes.

---

## 42. Contexto AWS por mensagem

Quando útil, enviar `Context` não sensível:

```ts
Context: {
  internalMessageId: message.id,
  campaignId: campaign?.id ?? "manual",
}
```

Não colocar:

- nome completo;
- email;
- telefone;
- conteúdo do SMS;
- tokens;
- PII desnecessária.

O contexto pode aparecer em eventos/logs de entrega.

---

## 43. Custos

Não hardcode preços na aplicação.

Os preços de SMS dependem de:

- país;
- route;
- identidade de origem;
- número de partes;
- taxas de operador;
- alterações de pricing AWS.

Mostrar apenas:

- número estimado de partes;
- volume de destinatários;
- custo real quando este vier de dados de eventos/relatórios AWS.

Se for necessário estimar preço, criar uma fonte de configuração versionada e mostrar claramente:

```text
Estimativa — não é valor final
```

---

## 44. Portugal

O primeiro mercado considerado é Portugal.

Configuração inicial sugerida:

```text
Country: PT
Calling code: +351
AWS region: eu-west-1
UI timezone: Europe/Lisbon
```

Portugal suporta Sender ID no AWS End User Messaging SMS.

Para comunicação apenas de saída, considerar Sender ID.

Para fluxos que exigem respostas do destinatário, utilizar uma identidade de origem com suporte a two-way SMS; um Sender ID alfanumérico não suporta replies.

Não assumir que regras de SMS são iguais em todos os países.

Antes de ativar um novo país:

1. verificar suporte AWS;
2. verificar requisitos de registo;
3. verificar tipo de origination identity;
4. verificar opt-in/opt-out;
5. verificar horários/restrições;
6. atualizar Protect Configuration;
7. testar;
8. documentar.

---

## 45. Deployment

Não acoplar o código a uma única plataforma de hosting.

Requisitos de produção:

- runtime Node suportado;
- acesso PostgreSQL;
- IAM role/credenciais AWS seguras;
- HTTPS;
- secrets manager da plataforma;
- migrations controladas;
- logs;
- backups;
- health check.

Se deploy for na AWS, considerar posteriormente:

```text
App Runner / ECS / Lambda
RDS PostgreSQL
SQS
SNS
CloudWatch
Secrets Manager
```

Escolher apenas os componentes necessários.

Não criar infraestrutura complexa antes de haver necessidade real.

---

## 46. README obrigatório

O `README.md` deverá conter:

1. visão geral;
2. arquitetura;
3. requisitos;
4. instalação local;
5. configuração PostgreSQL;
6. variáveis de ambiente;
7. execução;
8. testes;
9. configuração AWS;
10. sandbox;
11. pedido de production access;
12. origination identity;
13. Sender ID/número;
14. Configuration Set;
15. Protect Configuration;
16. IAM;
17. dry-run;
18. deployment;
19. troubleshooting;
20. segurança/compliance.

---

## 47. Checklist para primeiro envio real

Não fazer primeiro envio real até todos estarem confirmados:

- [ ] Conta AWS correta
- [ ] Região correta
- [ ] AWS End User Messaging SMS configurado
- [ ] Production access aprovado, ou destino de teste verificado
- [ ] Origination identity ativa
- [ ] Sender ID/número/pool correto
- [ ] Protect Configuration configurada
- [ ] Configuration Set configurado
- [ ] IAM mínimo configurado
- [ ] Número em E.164
- [ ] Consentimento confirmado quando aplicável
- [ ] Contacto não está em opt-out
- [ ] Tipo TRANSACTIONAL/PROMOTIONAL correto
- [ ] Mensagem validada
- [ ] Estimativa de segmentos visível
- [ ] Limites de gastos configurados
- [ ] Dry-run testado
- [ ] Audit log funcional
- [ ] Confirmação explícita do operador

---

## 48. Critérios do MVP

O MVP estará pronto quando for possível:

1. iniciar sessão;
2. criar/importar contactos;
3. guardar consentimento;
4. marcar opt-out;
5. criar template;
6. enviar um SMS de teste;
7. enviar um SMS real autorizado;
8. criar campanha;
9. excluir automaticamente contactos inelegíveis;
10. confirmar envio;
11. processar sem duplicados;
12. ver histórico;
13. distinguir aceitação de entrega;
14. auditar quem iniciou o envio;
15. executar lint, typecheck, testes e build com sucesso.

---

## 49. Fontes técnicas oficiais

Consultar prioritariamente documentação oficial AWS.

AWS End User Messaging SMS:
https://docs.aws.amazon.com/sms-voice/latest/userguide/what-is-sms-mms.html

Getting started:
https://docs.aws.amazon.com/sms-voice/latest/userguide/getting-started.html

Sandbox:
https://docs.aws.amazon.com/sms-voice/latest/userguide/sandbox.html

Send SMS:
https://docs.aws.amazon.com/sms-voice/latest/userguide/send-sms-voice-message.html

SendTextMessage API:
https://docs.aws.amazon.com/pinpoint/latest/apireference_smsvoicev2/API_SendTextMessage.html

AWS SDK JavaScript v3:
https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-pinpoint-sms-voice-v2

Sender IDs:
https://docs.aws.amazon.com/sms-voice/latest/userguide/sender-id.html

Supported countries:
https://docs.aws.amazon.com/sms-voice/latest/userguide/phone-numbers-sms-by-country.html

Opt-out:
https://docs.aws.amazon.com/sms-voice/latest/userguide/opt-out-list.html

Configuration Sets:
https://docs.aws.amazon.com/sms-voice/latest/userguide/configuration-sets.html

Event destinations:
https://docs.aws.amazon.com/sms-voice/latest/userguide/configuration-sets-event-destinations.html

SMS character limits:
https://docs.aws.amazon.com/sms-voice/latest/userguide/sms-limitations-character.html

MPS:
https://docs.aws.amazon.com/sms-voice/latest/userguide/sms-limitations-mps.html

IAM actions:
https://docs.aws.amazon.com/service-authorization/latest/reference/list_pinpoint-sms-voice-v2.html

---

## 50. Primeira instrução ao Claude Code

Depois de receber este ficheiro, começar com:

```text
Analisa o CLAUDE.md e o estado atual do repositório.
Não implementes tudo de uma vez.

Primeiro:
1. apresenta um resumo curto da arquitetura proposta;
2. identifica o que já existe no projeto;
3. identifica diferenças entre o repositório e o CLAUDE.md;
4. cria um plano de implementação por fases;
5. começa apenas pela Fase 0 e Fase 1;
6. mantém a aplicação funcional;
7. executa lint, typecheck, testes e build antes de concluir.

Não efetues envios SMS reais nem alterações destrutivas na AWS sem instrução explícita.
```
