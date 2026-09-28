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
pnpm install
pnpm db:migrate --name init
pnpm db:seed
pnpm dev
```

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
  lib/
    auth/                sessões e autorização
    db/                  Prisma
    phone/               E.164 e masking
    sms/                 providers e segmentação
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
