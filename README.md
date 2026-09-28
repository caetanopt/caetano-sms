# SMS AWS Starter

Starter para uma aplicação web de envio de SMS através do **AWS End User Messaging SMS**.

## Incluído

- Next.js 16 + TypeScript strict
- PostgreSQL + Prisma ORM 7
- autenticação local com sessão HTTP-only
- roles ADMIN / OPERATOR / VIEWER
- contactos + consentimento/opt-out
- envio individual
- `FakeSmsProvider` para desenvolvimento seguro
- `AwsSmsProvider` com AWS SDK v3
- histórico de mensagens
- auditoria
- normalização E.164
- cálculo de segmentos GSM/UCS-2
- Docker Compose para PostgreSQL
- testes Vitest
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

1. melhorar gestão de utilizadores e autorização;
2. listas e importação CSV;
3. templates;
4. campanhas e idempotência;
5. SQS para jobs;
6. Configuration Set + SNS/SQS para delivery receipts;
7. rate limiting e limites por identidade/país;
8. E2E com Playwright;
9. hardening e deployment.

## Segurança

- nunca fazer commit do `.env`;
- usar IAM Role em produção, evitando access keys estáticas;
- nunca contornar opt-out;
- não assumir que `ACCEPTED` significa `DELIVERED`;
- confirmar base legal/consentimento para mensagens promocionais;
- manter Protect Configuration e limites de gastos configurados na AWS.
