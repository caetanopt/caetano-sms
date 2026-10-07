# SMS AWS Starter

Starter para uma aplicação web de envio de SMS através do **AWS End User Messaging SMS**.

## Incluído

- Next.js 16 + TypeScript strict
- PostgreSQL + Prisma ORM 7
- autenticação local com sessão HTTP-only
- roles ADMIN / OPERATOR / VIEWER, gestão de utilizadores pela UI e 2FA (TOTP) obrigatório para ADMIN
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
- rate limiting partilhado por campanhas e envio individual, serializado com `pg_advisory_xact_lock`
  — exceção documentada à regra de SQL só pelo ORM (`src/server/services/send-rate.ts`). Ver
  [Rate limiting](#rate-limiting-mps);
- o SDK AWS é criado com `maxAttempts: 1` e timeouts finitos (3 s ligação / 10 s pedido):
  `SendTextMessage` não é idempotente na AWS, pelo que só a aplicação decide retries.

Fila: `SmsJobQueue` com `DirectSmsJobQueue` (defeito: o job corre dentro do passo) ou
`SqsSmsJobQueue` (`SMS_JOB_QUEUE=sqs`, ver [Fila SQS](#fila-sqs)); o domínio não depende do SQS.

| Variável | Defeito | Significado |
|---|---|---|
| `SMS_MAX_RECIPIENTS_PER_CAMPAIGN` | 500 | máximo de elegíveis por campanha |
| `SMS_MAX_SENDS_PER_MINUTE` | 60 | limite global de envios (cada campanha pode apertar) |
| `SMS_USER_DAILY_PARTS_LIMIT` | 2000 | quota diária de partes SMS por utilizador |
| `SMS_CAMPAIGN_BATCH_SIZE` | 10 | mensagens por passo |
| `SMS_BULK_CONFIRMATION_THRESHOLD` | 50 | acima disto pede "ENVIAR N SMS" |
| `SMS_CAMPAIGN_MAX_ATTEMPTS` | 3 | tentativas por throttling antes de pausar |

### Rate limiting (MPS)

A AWS limita em **partes de mensagem por segundo (MPS)**, por identidade de origem e por país; os
valores dependem da conta e do tipo de origem (ver consola AWS → *Account/Phone numbers/Sender IDs*).
A aplicação aplica, antes de cada envio e de forma atómica:

1. `SMS_MAX_SENDS_PER_MINUTE` — mensagens por minuto (global);
2. token bucket da **identidade de origem** — `SMS_MPS_PER_ORIGIN` partes/s;
3. token bucket de **(identidade de origem, país de destino)** — `SMS_MPS_BY_COUNTRY` ou
   `SMS_MPS_COUNTRY_DEFAULT` partes/s.

Cada mensagem consome tantos tokens quantas as partes estimadas (uma mensagem com mais partes do
que a capacidade passa com o balde cheio e deixa saldo negativo). Os baldes estão na tabela
`SendRateBucket`, com a identidade guardada só como hash. Quando a AWS responde **THROTTLED**, os
baldes do destino são esvaziados e o ritmo cai para metade (mínimo 1/8), e depois recupera
linearmente (+0,02×/s). O backoff da campanha e o limite de tentativas mantêm-se.

As campanhas esperam dentro do passo quando a espera é curta (≤ 2 s); de outro modo o passo devolve
"A aguardar" com o limite atingido. A revisão da campanha mostra a **duração mínima estimada** com
estes limites. Um país lento pode atrasar os destinatários seguintes da mesma campanha (a ordem de
envio é preservada).

| Variável | Defeito | Significado |
|---|---|---|
| `SMS_MPS_PER_ORIGIN` | 1 | partes/s totais da identidade de origem |
| `SMS_MPS_BY_COUNTRY` | — | por país, ex.: `PT=5,ES=1` (ISO 3166-1 alfa-2) |
| `SMS_MPS_COUNTRY_DEFAULT` | 1 | partes/s para países sem valor explícito |
| `SMS_MPS_BURST_SECONDS` | 1 | rajada: capacidade = MPS × segundos |

Configurar **ao nível ou abaixo** do MPS indicado pela AWS. Com várias instâncias da aplicação, os
limites são partilhados (estado na base de dados).

### Limites por utilizador e por campanha

**Quota diária por utilizador** (`SMS_USER_DAILY_PARTS_LIMIT`, defeito 2000; override por utilizador
em `/users/[id]`, só ADMIN, auditado `USER_QUOTA_CHANGED`; `0` = sem envios sem desativar a conta):

- unidade: **partes SMS estimadas**; janela: **dia civil em Europe/Lisbon**, reinício automático às
  00:00 (dias de 23 h/25 h nas mudanças de hora);
- **quem paga**: o envio individual é do utilizador autenticado; uma campanha é de **quem a
  confirmou** na revisão §29 (retomar não transfere a quota);
- **o que conta**: todas as mensagens criadas hoje pelo utilizador, incluindo em modo de teste, exceto
  `FAILED` garantidamente não enviadas (`THROTTLED`, `PROVIDER_UNAVAILABLE`, `AUTH_ERROR`,
  `CONFIGURATION_ERROR`, `SPEND_LIMIT`, `QUOTA_EXCEEDED` — a retentativa é cobrada quando acontece),
  mais as reservas em curso (destinatários em processamento há menos de 5 min, mesmo que reservados
  antes da meia-noite) das campanhas que confirmou;
- **aplicação atómica**: a quota é verificada na **reserva**, sob o mesmo `pg_advisory_xact_lock` do
  limite por minuto e dos baldes de MPS — no envio individual na mesma transação que cria o
  `SmsMessage`; nas campanhas em `claimNextRecipient` (qualquer instância ou worker SQS). Dois pedidos
  simultâneos nunca passam ambos. Como a contagem usa várias consultas, **todo o INSERT de
  `SmsMessage` participa no lock**: o envio de campanha (já reservado) insere com o lock partilhado
  (`pg_advisory_xact_lock_shared`), que não bloqueia outros envios mas espera que uma reserva em curso
  termine de contar — sem isto, workers concorrentes podiam ultrapassar a quota numa mensagem. Um
  teste falha se aparecer outro sítio a inserir `SmsMessage`;
- **antes de confirmar**: a revisão §29 mostra "Quota diária de quem confirma" e **bloqueia** a
  confirmação se a campanha não couber no que resta hoje (descontando partes já comprometidas noutras
  campanhas suas por enviar). O `/send` mostra a quota e recusa mensagens que não cabem;
- **a meio de uma campanha**: se a quota se esgotar (por exemplo por envios individuais do mesmo
  utilizador), a campanha é **pausada automaticamente** com o motivo (`CAMPAIGN_HALTED`
  `USER_QUOTA_EXHAUSTED`) — nunca retoma sozinha à meia-noite ("NO silent bulk send"). Retomar é
  recusado enquanto a quota continuar esgotada; um ADMIN pode ajustar a quota;
- **desativar um utilizador** pausa de imediato as campanhas que confirmou (`CONFIRMER_INACTIVE`);
  a solução é cancelar e criar uma nova campanha para os destinatários restantes;
- deploy em bases existentes: passa a existir um limite diário por utilizador — ajustar o env e os
  overrides antes de atualizar.

**Ritmo por campanha**: no rascunho, "Ritmo máximo (mensagens por minuto)" só pode ser **igual ou
inferior** ao global `SMS_MAX_SENDS_PER_MINUTE` (validado no servidor; faz parte do que é revisto e do
fingerprint; congelado na confirmação). Espalha o envio no tempo sem afetar outras campanhas; a
revisão mostra a duração mínima estimada com o ritmo efetivo.

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

## Segurança operacional (Fase 7)

- **Headers**: CSP (`frame-ancestors 'none'`, sem recursos externos), `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS em produção (`src/lib/http/security-headers.ts`).
- **Login**: bloqueio após 5 falhas por email ou 20 por IP em 15 min; tempo constante para contas
  inexistentes; mensagens que não revelam se a conta existe; auditoria `LOGIN_*` com IP. Email e IP
  guardados só como HMAC. O IP só é lido de `X-Forwarded-For` com `TRUST_PROXY=true` (atrás de proxy
  de confiança).
- **Server Actions**: proteção CSRF nativa do Next (verificação de origem). Atrás de um proxy que
  altere o host, configurar `experimental.serverActions.allowedOrigins`.
- **Mensagens no URL (anti-phishing)**: as mensagens de feedback dos redirects (`?success=`,
  `?error=`, `?notice=`) são **assinadas** (HMAC-SHA256 com uma subchave de `AUTH_SECRET`) e
  **expiram em 2 minutos** (`src/lib/http/flash.ts`). A assinatura cobre também a **página de
  destino**: cada página indica a sua rota a `readFlash` e só aceita mensagens assinadas para ela
  (um teste confirma que cada `page.tsx` indica a própria rota). Um link forjado para o domínio real
  (ex.: `/login?error=A sua conta foi suspensa…`) não mostra nada, e os parâmetros são retirados do
  URL. **Regra**: o texto destas
  mensagens é sempre fixo, escrito no servidor (no máximo com números, ex.: minutos de bloqueio) —
  mensagens com nomes ou texto do utilizador voltam pelo estado do formulário, nunca pelo URL. As
  mensagens não estão ligadas à sessão (limitação aceite: só permite repetir uma mensagem fixa da
  aplicação na página que a produz); o prazo curto limita a reutilização de links guardados. Mudar
  `AUTH_SECRET` invalida apenas as mensagens em trânsito.
- **Dependências**: `pnpm audit:deps` (corre `pnpm audit` e o guarda dos advisories aceites).
  Overrides em `pnpm-workspace.yaml` para dependências transitivas (CLI do Prisma; `source-map-js`
  abaixo de 1.2.2 redirecionado para `^1.2.2`; `sharp` do Next abaixo de 0.35.5 redirecionado para
  `^0.35.5`, CVE-2026-96889 na librsvg). Advisories aceites conscientemente ficam em
  `audit.ignore`, cada um justificado em `scripts/check-audit-ignores.ts`. O pnpm ignora o GHSA em
  todos os caminhos, por isso o guarda faz falhar o comando se o pacote afetado entrar na árvore
  de produção ou se surgir um GHSA ignorado sem justificação. Hoje só GHSA-vfj7-8cjw-p6xm
  (`braces` ≤ 3.0.3, sem versão corrigida): o pacote que o audit vê está só na cadeia de lint
  (`eslint-config-next`); há cópias empacotadas no CLI do Prisma, `tsx`, vite e playwright, que
  correm com padrões fixos e nunca com input de utilizadores. Qualquer outro advisory (severidade
  low ou superior) continua a fazer falhar o `pnpm audit`. Rever quando sair versão corrigida.

### Gestão de utilizadores

Página `/users` (só ADMIN; não existe registo público):

- **criar** utilizador com perfil obrigatório; é gerada uma palavra-passe temporária mostrada **uma
  única vez** (nunca em URL, logs, auditoria nem email). No primeiro login o utilizador só consegue
  aceder a `/account/password` até definir a sua;
- **editar** nome, perfil e estado. Ninguém altera o próprio perfil nem se desativa, e nunca fica
  zero administradores ativos (transação serializável);
- **repor palavra-passe** de outro utilizador (nova temporária);
- auditoria recente da conta (`USER_CREATED`, `USER_ROLE_CHANGED`, `USER_DEACTIVATED`,
  `USER_PASSWORD_RESET`, `PASSWORD_CHANGED`, …).

Todos os utilizadores alteram a própria palavra-passe em `/account/password` (exige a atual; mínimo
12 caracteres, sem o email nem palavras comuns). **Sessões**: o token guarda uma versão de sessão
validada na base de dados em cada pedido; mudar perfil, desativar, repor ou alterar palavra-passe
termina de imediato as sessões abertas. Contas desativadas mantêm histórico e auditoria.
Recuperação do administrador: `pnpm db:seed` com `ADMIN_EMAIL`/`ADMIN_PASSWORD` repõe a conta.

### Verificação em dois passos (2FA)

**Obrigatória para ADMIN** (opcional para os outros perfis), com TOTP (RFC 6238: 6 dígitos, 30 s)
compatível com Google/Microsoft Authenticator, 1Password, Bitwarden, etc. O TOTP usa só
`node:crypto`; a única dependência é `qrcode` (geração da matriz do QR).

- **Configuração** em `/account/mfa`: **código QR** (gerado no servidor com `qrcode` e desenhado como
  SVG pelo React, sem pedidos externos), chave para introdução manual e ligação `otpauth://`; confirmada
  com um código antes de ativar. Um administrador sem 2FA só acede a esta página (e à alteração de
  palavra-passe), incluindo nas server actions. Ativar termina as outras sessões.
- **Login**: palavra-passe → `/login/mfa` (cookie assinado de 5 min, ligado à versão de sessão) →
  sessão com o claim `mfa`. Com 2FA ativo, uma sessão sem segundo fator nunca é válida.
- **Códigos de recuperação**: 10, de uso único, mostrados uma vez; só o HMAC é guardado. Podem ser
  regenerados com um código TOTP atual.
- **Segurança**: segredo cifrado com AES-256-GCM (chave derivada por HKDF de `MFA_ENCRYPTION_KEY` ou
  `AUTH_SECRET`); códigos não reutilizáveis (último passo guardado, com CAS); falhas contam para o
  mesmo bloqueio do login (5 por email / 20 por IP em 15 min); auditoria `MFA_*`, `LOGIN_MFA_FAILED`,
  `LOGIN_PASSWORD_VERIFIED`, `USER_MFA_RESET`.
- **Telemóvel perdido**: outro administrador usa **Repor 2FA** em `/users/<id>` (termina as sessões;
  configuração pedida no próximo login). Ninguém repõe o próprio 2FA. Sem outro administrador:
  `ADMIN_RESET_MFA=true pnpm db:seed` (requer acesso ao servidor e à base de dados).
- Promover um utilizador a ADMIN obriga-o a configurar o 2FA no próximo login.

| Variável | Defeito | Significado |
|---|---|---|
| `MFA_REQUIRED_FOR_ADMINS` | `true` | `false` só em desenvolvimento/testes |
| `MFA_ISSUER` | `SMS AWS` | nome na app de autenticação |
| `MFA_ENCRYPTION_KEY` | — | chave de cifra (≥ 32); vazio = derivada de `AUTH_SECRET` |

### Retenção de dados

`pnpm retention` mostra o que seria alterado; `pnpm retention --apply` aplica (auditado como
`RETENTION_APPLIED`). Agendar diariamente em produção **depois de validar os prazos com o DPO**:

| Variável | Defeito | Efeito |
|---|---|---|
| `SMS_RETENTION_DAYS` | 365 (mín. 30) | texto removido e número mascarado nas mensagens terminadas |
| `DELIVERY_EVENT_RETENTION_DAYS` | 365 | eventos de entrega apagados |
| `LOGIN_ATTEMPT_RETENTION_DAYS` | 30 | tentativas de login apagadas |
| `AUDIT_IP_RETENTION_DAYS` | 90 | IP removido dos registos de auditoria (o registo mantém-se) |

### Fila SQS

Com `SMS_JOB_QUEUE=sqs`, o passo da campanha (página ou `pnpm worker:campaigns`) **reserva** o
destinatário (rate limit incluído) e **publica** o job no Amazon SQS; `pnpm worker:sms-jobs`
recebe (long polling), envia e apaga a mensagem. Pode haver vários consumidores.

```text
passo da campanha ──SendMessage──▶ SQS ──ReceiveMessage──▶ worker:sms-jobs ──▶ AWS End User Messaging SMS
        (reserva + rate limit)        │                        (re-verifica consentimento, origem, envia)
                                      └──▶ DLQ após maxReceiveCount
```

- **Corpo da mensagem**: só `campaignId`, `recipientId` e `claimToken` (sem números, nomes nem texto).
- **Sem duplicados**: o SQS entrega pelo menos uma vez; o consumidor só atua se o destinatário ainda
  tiver o mesmo `claimToken`, e a chave de idempotência impede um segundo pedido à AWS. Um worker que
  morra a meio deixa o envio `UNKNOWN` (nunca repetido).
- **Mensagens perdidas/atrasadas**: reservas com mais de 5 min são reconciliadas e publicadas de
  novo com novo token; a mensagem antiga, se aparecer, não faz nada.
- **Modo/origem**: o consumidor compara o modo (TESTE/PRODUÇÃO), o fornecedor e a origem com os
  congelados na confirmação; se diferirem, **pausa a campanha em vez de enviar**. Configurar o
  worker com o mesmo `.env` que a aplicação.
- **Rajadas**: no máximo `SMS_SQS_MAX_IN_FLIGHT` destinatários em curso por campanha; o rate limit
  é aplicado na reserva.
- **Falhas**: publicação falhada liberta a reserva e o passo espera 5 s; erro no consumidor deixa a
  mensagem voltar a ficar visível; mensagens inválidas são apagadas. Configurar uma **DLQ**.
- Standard e FIFO suportadas (FIFO: `MessageGroupId` = campanha, deduplicação pela reserva).

| Variável | Defeito | Significado |
|---|---|---|
| `SMS_JOB_QUEUE` | `direct` | `direct` ou `sqs` |
| `AWS_SQS_SMS_JOBS_QUEUE_URL` | — | URL da fila (tem de estar em `AWS_REGION`) |
| `SMS_SQS_MAX_IN_FLIGHT` | 10 | destinatários em curso por campanha |
| `SMS_SQS_VISIBILITY_TIMEOUT_SECONDS` | 60 | visibility timeout da receção (30–900) |

Criação da fila, DLQ e permissões IAM: `docs/AWS_SETUP.md` (secção 12, requer aprovação).

### Worker de campanhas

`pnpm worker:campaigns` processa em segundo plano as campanhas **já iniciadas** por um operador
(nunca inicia uma campanha confirmada mas não iniciada, nem retoma uma pausada). Pode correr em
paralelo com a página e com outras instâncias: o lease e as chaves de idempotência impedem
duplicados. Termina de forma graciosa em `SIGTERM`.

### Observabilidade

As métricas são calculadas a partir da base de dados (fonte de verdade partilhada por todas as
instâncias) e, com SQS, dos atributos da fila. Nunca incluem números, nomes ou texto de SMS.

- **Página `/observability`** (só ADMIN): envios por janela (15 min / 1 h / 24 h) com aceites,
  falhados, incertos, pendentes, throttling, envios de teste e latência do provider (p50/p95);
  campanhas a enviar, pausadas (e por erro) e terminadas com falhas; destinatários presos/incertos;
  aceites sem recibo há mais de 24 h; baldes de MPS abrandados; profundidade da fila SQS e DLQ;
  erros por código; e **alertas** derivados.
- **`GET /api/metrics`** (Prometheus, text format 0.0.4): desativado (404) sem `METRICS_TOKEN`;
  exige `Authorization: Bearer <METRICS_TOKEN>`. Métricas `sms_*` do tipo gauge sobre janelas
  (ex.: `sms_messages_window{window,outcome}`, `sms_throttled_window`, `sms_errors_window{code}`,
  `sms_provider_latency_ms{window,quantile}`, `sms_campaigns_paused_with_error`,
  `sms_campaign_recipients_stuck`, `sms_queue_messages{queue,state}`, `sms_queue_up`).
- Quotas: `sms_quota_users_exhausted_today`, `sms_campaigns_halted_by_quota_24h` e dois avisos na página.
- **CloudWatch EMF**: com `METRICS_EMF=true`, `pnpm worker:campaigns` escreve a cada
  `METRICS_EMF_INTERVAL_SECONDS` uma linha JSON que o CloudWatch Logs converte em métricas no
  namespace `METRICS_EMF_NAMESPACE` (sem chamadas à AWS). Ativar num único worker.
- A latência de cada chamada ao provider fica em `SmsMessage.providerLatencyMs`; os logs
  `sms.send.*` e `sms.job.*` incluem `durationMs`.

| Alerta | Nível | Regra |
|---|---|---|
| campanha pausada por erro | crítico | circuit breaker ativo |
| erros de conta AWS | crítico | `AUTH_ERROR`/`CONFIGURATION_ERROR`/`SPEND_LIMIT`/`QUOTA_EXCEEDED` em 15 min |
| taxa de falhas | crítico | > 20% com ≥ 20 resultados em 15 min |
| fila SQS ilegível / DLQ com mensagens | crítico | `sms_queue_up = 0` / DLQ > 0 |
| throttling, resultados incertos | aviso | > 0 em 15 min |
| destinatários presos | aviso | `PROCESSING` há mais de 5 min |
| sem recibo de entrega | aviso | aceites há > 24 h (só com eventos configurados) |

| Variável | Defeito | Significado |
|---|---|---|
| `METRICS_TOKEN` | — | token do `/api/metrics` (≥ 32 caracteres, segredo) |
| `METRICS_EMF` | `false` | snapshot EMF no worker de campanhas |
| `METRICS_EMF_INTERVAL_SECONDS` | 60 | intervalo do snapshot (10–3600) |
| `METRICS_EMF_NAMESPACE` | `SmsApp` | namespace CloudWatch |
| `AWS_SQS_SMS_JOBS_DLQ_URL` | — | DLQ, só para a métrica de profundidade |

## Deployment

Requisitos: Node 22.12+, PostgreSQL 16, HTTPS, gestor de segredos da plataforma, IAM Role (sem access keys).

```bash
pnpm install --frozen-lockfile
pnpm build                        # não precisa de DATABASE_URL
pnpm prisma migrate deploy        # antes de cada release (nunca migrate dev em produção)
pnpm start                        # web
pnpm worker:campaigns             # processo separado (1+ instâncias)
pnpm retention --apply            # cron diário, depois de validados os prazos
```

- Variáveis obrigatórias: `DATABASE_URL`, `AUTH_SECRET` (≥32 caracteres, segredo), `NODE_ENV=production`,
  `SMS_PROVIDER`, `AWS_SMS_DRY_RUN` (explícito), `AWS_REGION`, `AWS_SMS_ORIGINATION_IDENTITY`,
  `AWS_SMS_CONFIGURATION_SET`, `AWS_SMS_PROTECT_CONFIGURATION_ID`; opcionais as de eventos e limites.
- Health checks: `GET /api/health` (liveness, sem dependências) e `GET /api/health/ready`
  (verifica a base de dados; 503 se indisponível). Nenhum envia SMS.
- Backups diários do PostgreSQL com retenção alinhada com a política acima; testar restauros.
- Logs JSON no stdout (sem números completos nem texto das mensagens) → CloudWatch/agregador.
- Métricas: `/api/metrics` (Prometheus, com `METRICS_TOKEN`) ou EMF no worker; ver
  [Observabilidade](#observabilidade).
- Na AWS (quando aplicável): App Runner/ECS + RDS PostgreSQL + Secrets Manager; o worker como
  serviço separado. Não criar infraestrutura antes de haver necessidade real (§45).

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

## Identidade visual

A interface segue o **Brand Book Caetano (04/2026)**:

- **Wordmark**: desenho autoral extraído do vetor oficial do manual (`src/components/brand/`); nunca é
  substituído por texto ou fonte. Branco sobre azul profundo; cyan/azul profundo sobre fundos claros;
  altura mínima de 14 px.
- **Cores**: azul profundo `#002E5D` (principal), azul cyan `#00AEEF`, cinza antracite `#2E3A46`,
  cinza médio `#9CAEB8`, verde eco, laranja dinâmico, amarelo liberdade e respetivas gradações, como
  tokens Tailwind (`brand-*`) em `src/app/globals.css`. As escalas `slate`/`indigo`/`emerald`/`amber`
  usadas nas páginas estão remapeadas para a paleta da marca, com contraste AA para texto.
- **Tipografia**: Montserrat (servida pela própria aplicação, `@fontsource-variable/montserrat`; sem
  pedidos externos, compatível com a CSP). Claim "Your favourite way to move" em Montserrat Medium `#2aa8e0`.
- **Animações**: entrada das páginas em cascata, elevação dos cartões, trajetos animados no login
  ("a Caetano liga trajetos"); desativadas com `prefers-reduced-motion`.
- **Favicon e ícones** (`src/app/icon.svg`, `favicon.ico`, `apple-icon.png`): gerados do wordmark
  oficial por `pnpm brand:icons` (`src/components/brand/icon-art.ts`; voltar a correr se o vetor
  mudar — os testes falham se os ficheiros ficarem desatualizados). O separador usa o tratamento do
  avatar oficial das redes sociais (§09): disco azul profundo com o wordmark branco a 84 % (dentro
  da área de segurança), que passa a azul cyan em modo escuro. Nos tamanhos de separador
  (16–48 px) o wordmark fica aquém do mínimo de 14 px por imposição do browser, como nos avatares
  reduzidos; o ícone iOS (180 px, quadrado opaco) cumpre-o. Não se usa monograma: o manual não
  define nenhum símbolo além do wordmark.

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

1. criar os recursos AWS com `pnpm aws:provision --account <id>` (plano; `--apply` para criar —
   docs/AWS_SETUP.md §14, requer aprovação e credenciais da conta certa);
2. primeiro envio real autorizado seguindo a checklist do §47;
3. criar a fila SQS + DLQ (docs/AWS_SETUP.md §12) e ativar `SMS_JOB_QUEUE=sqs` quando o volume justificar;
4. alarmes CloudWatch sobre as métricas EMF (DLQ, campanhas pausadas por erro, throttling);
5. passkeys (WebAuthn) se necessário.

## Segurança

- nunca fazer commit do `.env`;
- usar IAM Role em produção, evitando access keys estáticas;
- nunca contornar opt-out;
- não assumir que `ACCEPTED` significa `DELIVERED`;
- confirmar base legal/consentimento para mensagens promocionais;
- manter Protect Configuration e limites de gastos configurados na AWS.
