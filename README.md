# SMS AWS Starter

Starter para uma aplicação web de envio de SMS através do **AWS End User Messaging SMS**.

## Incluído

- Next.js 16 + TypeScript strict
- PostgreSQL + Prisma ORM 7
- autenticação local com sessão HTTP-only
- roles ADMIN / OPERATOR / VIEWER
- contactos com histórico de consentimento, opt-out e suppression list local
- listas de contactos e importação CSV com validação
- templates com variáveis de whitelist e pré-visualização
- campanhas com revisão §29, confirmação explícita e envio por lotes idempotente
- testes E2E com Playwright
- eventos de entrega via SNS com validação de assinatura e estados idempotentes
- envio individual
- `FakeSmsProvider` para desenvolvimento seguro
- `AwsSmsProvider` com AWS SDK v3
- histórico de mensagens
- auditoria
- normalização E.164
- cálculo de segmentos GSM/UCS-2
- Docker Compose para PostgreSQL
- testes Vitest (unitários e de integração com PostgreSQL)
- endpoint `/api/health`

O envio real está **desativado por defeito**: `SMS_PROVIDER=fake` e `AWS_SMS_DRY_RUN=true`.

## Requisitos

- Node.js 22.12+
- pnpm 10+
- Docker + Docker Compose, ou PostgreSQL acessível

## Arranque rápido

```bash
cp .env.example .env
# altera AUTH_SECRET, ADMIN_EMAIL e ADMIN_PASSWORD

docker compose up -d
pnpm install          # também executa `prisma generate`
pnpm db:migrate       # aplica as migrações em prisma/migrations
pnpm db:seed
pnpm dev
```

Notas:

- O `pnpm-workspace.yaml` autoriza explicitamente (`allowBuilds`) os build scripts de
  `prisma`, `@prisma/engines`, `esbuild` e `unrs-resolver`. Sem isso o pnpm 11 recusa a instalação.
- Em produção aplicar migrações com `pnpm prisma migrate deploy` (nunca `migrate dev`).
- `pnpm build` não precisa de `DATABASE_URL`; a ligação à base de dados só é criada em runtime.

Abrir `http://localhost:3000` e iniciar sessão com `ADMIN_EMAIL` e `ADMIN_PASSWORD`.

## Contactos, consentimento e listas

- `/contacts`: pesquisa (nome ou telefone), filtro por consentimento, paginação e criação.
- `/contacts/[id]`: edição, histórico de consentimento, opt-in/opt-out, listas e eliminação (ADMIN).
- `/contacts/import`: importação CSV com preview, mapeamento de colunas, validação e relatório.
- `/lists`: listas/grupos com contagens de elegibilidade (opt-in / sem consentimento / opt-out).

Regras (ver `src/features/contacts/consent.ts` e `src/features/contacts/import.ts`):

- cada alteração de consentimento cria um `ConsentEvent` imutável: estado, origem, finalidade,
  versão do texto, processo (`manual`, `csv-import`, `provider`) e utilizador;
- opt-in exige origem e finalidade; não existe transição manual para "desconhecido";
- opt-out adiciona o número à **suppression list** (`SuppressionEntry`), que é verificada em todos os
  envios, mesmo para números sem contacto, e **não** é limpa quando o contacto é eliminado;
- só ADMIN pode registar um novo opt-in num número em opt-out ou eliminar contactos;
- VIEWER só tem acesso de leitura e vê os números mascarados.

### Importação CSV

Formato recomendado (vírgula ou ponto e vírgula; UTF-8 ou Windows-1252; máx. 5000 linhas / 2 MB):

```csv
name,phone,consent_status,consent_source
Maria,+351912345678,OPTED_IN,website
Joao,+351913456789,UNKNOWN,legacy-import
```

- a presença de um número no ficheiro **nunca** é consentimento;
- `OPTED_IN` só é importado se o operador confirmar que o consentimento está documentado **e** a
  linha tiver origem; caso contrário fica `UNKNOWN` (com aviso no relatório);
- `OPTED_OUT` é sempre aplicado, inclusive a contactos já existentes;
- contactos existentes nunca sobem de consentimento; números na suppression list ficam em opt-out;
- linhas inválidas e duplicados (após normalização E.164) são rejeitados e listados;
- reimportar o mesmo ficheiro não cria duplicados.

## Templates

`/templates` permite criar, editar e eliminar templates com tipo de mensagem obrigatório e
pré-visualização com contador de partes. Motor em `src/lib/sms/templates.ts`.

Variáveis permitidas (whitelist):

| Variável | Origem |
|---|---|
| `{{firstName}}`, `{{lastName}}`, `{{fullName}}` | contacto registado com o número |
| `{{date}}`, `{{time}}`, `{{place}}` | indicadas pelo operador no envio |

- nunca há `eval` nem execução de código: substituição textual numa única passagem (um valor com
  `{{...}}` nunca é expandido); variáveis desconhecidas ou placeholders mal formados são rejeitados;
- telefone e email **não** são variáveis, para não pôr PII desnecessária no texto;
- variável em falta **bloqueia o envio** e indica o campo (e, nas campanhas, o contacto);
- ao usar um template, o texto e o tipo vêm da base de dados: o tipo não pode ser alterado
  (nunca converter promocional em transacional) e a tentativa é auditada;
- as partes são calculadas sobre o texto final; nomes com ã, õ, ç ou emoji passam a Unicode
  (70 caracteres por parte). O próprio texto "marcação" já obriga a Unicode;
- eliminar um template mantém as mensagens enviadas (com o texto final).

## Campanhas

`/campaigns` → nova campanha (lista + template ou texto livre + tipo + valores das variáveis).

1. **Rascunho**: guardar nunca envia. Só rascunhos podem ser editados ou eliminados.
2. **Revisão (§29)**: calculada no servidor a partir da base de dados — elegíveis, excluídos por
   opt-out, sem consentimento, números inválidos, partes estimadas, origem mascarada, modo, lista de
   destinatários (número normalizado mascarado + mensagem final) e contactos com variáveis em falta
   (bloqueiam a confirmação). Campanhas exigem **sempre** opt-in, qualquer que seja o tipo.
   Promocionais mostram a finalidade dos opt-in e exigem confirmação de que abrangem marketing.
3. **Confirmação**: "Confirmar e enviar"; acima de `SMS_BULK_CONFIRMATION_THRESHOLD` é pedida a
   frase exata `ENVIAR N SMS` (validada no servidor). Um fingerprint garante que nada mudou desde a
   revisão (lista, consentimentos, texto, modo, origem). Os destinatários e o texto final ficam congelados.
4. **Envio**: por passos curtos, conduzidos pela página da campanha **depois de um clique explícito**
   (ou logo após confirmar). Abrir a página nunca envia. Pausar/retomar/cancelar ficam guardados no
   servidor e auditados.

Garantias do motor (`src/server/services/campaigns/engine.ts`):

- idempotência: chave `campaign:{campanha}:{destinatário}:{tentativa}` (UNIQUE); a tentativa só
  aumenta depois de uma falha garantidamente não enviada — recuperações e passos concorrentes
  colidem na mesma chave e nunca reenviam;
- cada destinatário é reservado imediatamente antes do envio e todas as transições são CAS sobre o
  seu `claimToken`; um lease com dono por campanha é renovado antes de cada envio;
- consentimento, opt-out e suppression list são **re-verificados imediatamente antes de cada envio**;
- resultados incertos (`UNKNOWN`) nunca são repetidos; 3 seguidos pausam a campanha;
- erros de conta (autenticação, configuração, limite de gastos, quota) pausam a campanha sem gastar
  destinatários; throttling faz backoff exponencial com jitter ao nível da campanha;
- se o modo (TESTE/PRODUÇÃO), o fornecedor ou a origem mudarem depois da confirmação, o envio para;
- rate limit global `SMS_MAX_SENDS_PER_MINUTE` (campanhas + envio individual), serializado com
  `pg_advisory_xact_lock` — exceção documentada à regra de SQL só pelo ORM (`src/server/services/send-rate.ts`);
- o SDK AWS é criado com `maxAttempts: 1` e timeouts finitos (3 s ligação / 10 s pedido):
  `SendTextMessage` não é idempotente na AWS, pelo que só a aplicação decide retries.

Fila: `SmsJobQueue` com `DirectSmsJobQueue` (MVP: o job corre dentro do passo). Uma implementação
`SqsSmsJobQueue` + worker é o passo seguinte para produção; o domínio não depende do SQS.

| Variável | Defeito | Significado |
|---|---|---|
| `SMS_MAX_RECIPIENTS_PER_CAMPAIGN` | 500 | máximo de elegíveis por campanha |
| `SMS_MAX_SENDS_PER_MINUTE` | 60 | limite global de envios |
| `SMS_CAMPAIGN_BATCH_SIZE` | 10 | mensagens por passo |
| `SMS_BULK_CONFIRMATION_THRESHOLD` | 50 | acima disto pede "ENVIAR N SMS" |
| `SMS_CAMPAIGN_MAX_ATTEMPTS` | 3 | tentativas por throttling antes de pausar |

Privacidade: o texto final por destinatário é apagado quando o destinatário termina ou o contacto
é eliminado (o texto enviado fica em `SmsMessage`). **Retenção por definir com o DPO** (proposta: anonimizar
corpo e número de `SmsMessage` após 12 meses) — a implementar na Fase 7.

## Eventos de entrega

`POST /api/webhooks/aws-sms-events` recebe os eventos do Configuration Set via SNS
(configuração na AWS em `docs/AWS_SETUP.md` → "Eventos de entrega"; **não** é criada automaticamente).

- valida a assinatura SNS, o certificado (`sns.<região>.amazonaws.com`), o tópico
  (`AWS_SMS_EVENTS_SNS_TOPIC_ARN`) e a idade da mensagem (replay); desativado sem tópico configurado;
- idempotente (MessageId SNS único) e tolerante à ordem: o estado nunca recua e estados finais
  (`DELIVERED`, `FAILED`, `UNROUTABLE`, `PROTECT_BLOCKED`) nunca são substituídos;
- mensagens em estado incerto (`UNKNOWN`, sem `awsMessageId`) são associadas pelo
  `Context.internalMessageId` enviado com cada SMS — um evento prova que saíram;
- opt-out reportado pela AWS atualiza a suppression list local;
- guarda o custo real por mensagem quando a AWS o reporta (dashboard: "Custo real");
- não guarda o número nem o payload bruto dos eventos.

| Evento | Estado |
|---|---|
| `TEXT_PENDING`, `TEXT_QUEUED` | Em fila |
| `TEXT_SENT`, `TEXT_SUCCESSFUL` | Enviado ao operador |
| `TEXT_DELIVERED` | Entregue |
| `TEXT_BLOCKED`, `TEXT_CARRIER_BLOCKED`, `TEXT_SPAM`, `TEXT_INVALID_MESSAGE`, `TEXT_TTL_EXPIRED` | Falhou |
| `TEXT_INVALID`, `TEXT_UNREACHABLE`, `TEXT_CARRIER_UNREACHABLE` | Sem rota |
| `TEXT_PROTECT_BLOCKED` | Bloqueado (Protect) |
| `TEXT_UNKNOWN` | Resultado incerto (não rebaixa "em fila/enviado") |

Sem eventos configurados, o dashboard avisa que "aceite" não significa "entregue".

## Validação

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Ou:

```bash
pnpm validate
```

Testes E2E (Playwright, build de produção, provider fake, base de dados de **teste** apagada no início):

```bash
pnpm test:e2e
```

Testes de integração (PostgreSQL real, base de dados **separada**):

```bash
# docker compose cria sms_app_test na primeira inicialização; caso contrário:
# createdb -O smsapp sms_app_test
TEST_DATABASE_URL=postgresql://smsapp:smsapp@localhost:5432/sms_app_test
pnpm test:integration   # aplica as migrações e apaga os dados dessa base de dados
```

## Envio em modo fake

Por defeito:

```bash
SMS_PROVIDER=fake
AWS_SMS_DRY_RUN=true
```

O fluxo completo é executado e persistido na base de dados, mas não é feita chamada real à AWS.
As mensagens enviadas em modo de teste ficam marcadas (`dryRun`) e aparecem com a etiqueta **TESTE** no histórico.

Para desenvolver o tratamento de erros sem AWS, o provider fake aceita cenários:

```bash
SMS_FAKE_SCENARIO=success   # success | failure | throttle | opt_out | uncertain
SMS_FAKE_DELAY_MS=0         # latência simulada (0-30000 ms)
```

## Fluxo de envio individual

1. O operador preenche destinatário, tipo (obrigatório escolher) e mensagem; o contador mostra
   caracteres, encoding e partes estimadas em tempo real.
2. **Rever envio**: o servidor normaliza o número (E.164), procura o contacto, aplica opt-out e
   consentimento e mostra o resumo (número normalizado, contacto, partes, origem mascarada, modo).
3. **Confirmar e enviar**: o servidor repete todas as validações, cria o `SmsMessage` como `PENDING`
   com chave de idempotência e só depois chama o provider.

Orquestração em `src/server/services/manual-send.ts`; persistência em
`src/server/repositories/prisma-manual-send-store.ts`.

## Erros do provider e estados

Os erros da AWS são traduzidos em `src/lib/sms/aws-errors.ts` para códigos internos
(`THROTTLED`, `OPTED_OUT`, `SPEND_LIMIT`, `PROTECT_BLOCKED`, `DESTINATION_NOT_VERIFIED`,
`AUTH_ERROR`, `CONFIGURATION_ERROR`, …) com `retryable` e `uncertain` explícitos.
São guardados o código, uma mensagem segura, o nome do erro AWS e o request id.

| Resultado | Estado `SmsMessage` | Significado |
|---|---|---|
| Aceite | `ACCEPTED` | Aceite pelo fornecedor — **não** significa entregue |
| Falha definitiva | `FAILED` | O fornecedor rejeitou; não foi enviado |
| Resultado incerto | `UNKNOWN` | Timeout/5xx/erro inesperado: pode ter sido enviado. **Nunca reenviar sem verificar.** |

Quando a AWS indica que o destino está em opt-out, o contacto local é marcado como `OPTED_OUT`
(suppression list local) e o evento é auditado.

Os logs são JSON estruturado (`sms.send.accepted`, `sms.send.failed`, `sms.send.uncertain`, …)
com telefone mascarado e sem o texto da mensagem.

## Ativar AWS

Ler `docs/AWS_SETUP.md` antes de alterar a configuração.

Só depois configurar:

```bash
SMS_PROVIDER=aws
AWS_REGION=eu-west-1
AWS_SMS_ORIGINATION_IDENTITY=<sender-id-number-or-pool>
AWS_SMS_CONFIGURATION_SET=<configuration-set>
AWS_SMS_PROTECT_CONFIGURATION_ID=<protect-config>
AWS_SMS_DRY_RUN=true
```

Começar sempre com `AWS_SMS_DRY_RUN=true`.

Para um envio real, alterar explicitamente para:

```bash
AWS_SMS_DRY_RUN=false
```

## Estrutura

```text
src/
  app/                  páginas e server actions
  components/           componentes partilhados
  features/             tipos/estado partilhados por funcionalidade
  lib/
    auth/                sessões e autorização
    db/                  Prisma
    logging/             logging estruturado
    phone/               E.164 e masking
    sms/                 providers, config, erros AWS, elegibilidade e segmentação
  server/
    services/            casos de uso (ex.: envio individual)
    repositories/        persistência Prisma
  generated/             Prisma Client (ignorado no git)
prisma/
  schema.prisma
  seed.ts
tests/
docs/
CLAUDE.md
```

## Próximas fases

O `CLAUDE.md` contém o plano completo. A evolução recomendada é:

1. criar na AWS o Configuration Set + SNS (comandos em docs/AWS_SETUP.md, requer aprovação);
2. `SqsSmsJobQueue` + worker para campanhas sem depender da página aberta;
3. gestão de utilizadores pela UI;
4. rate limiting por identidade/país, headers de segurança, retenção;
5. hardening e deployment.

## Segurança

- nunca fazer commit do `.env`;
- usar IAM Role em produção, evitando access keys estáticas;
- nunca contornar opt-out;
- não assumir que `ACCEPTED` significa `DELIVERED`;
- confirmar base legal/consentimento para mensagens promocionais;
- manter Protect Configuration e limites de gastos configurados na AWS.
