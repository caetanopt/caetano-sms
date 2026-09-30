/**
 * Provisionamento dos recursos AWS da aplicação (docs/AWS_SETUP.md: eventos, §12, §13).
 * Código puro: argumentos, plano (o que falta criar) e regras de países. As chamadas à AWS
 * vivem no adaptador; nada aqui envia SMS, apaga ou altera a identidade de origem.
 */

export type ProvisionConfig = {
  /** Conta esperada: o script recusa correr noutra conta (evita erros de perfil). */
  account: string;
  region: string;
  configurationSetName: string;
  eventDestinationName: string;
  topicName: string;
  /** ISO 3166-1 alfa-2 permitidos na Protect Configuration; todos os outros ficam bloqueados. */
  allowedCountries: string[];
  /** https://…/api/webhooks/aws-sms-events — sem valor, o tópico fica sem subscrição. */
  webhookUrl: string | null;
  sqs: { queueName: string; dlqName: string } | null;
  /** Tópico SNS para onde os alarmes notificam; sem valor, os alarmes não são criados. */
  alarmTopicArn: string | null;
  metricsNamespace: string;
  apply: boolean;
};

export type ParseResult = { ok: true; config: ProvisionConfig } | { ok: false; error: string };

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const SNS_ARN = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/;
export const WEBHOOK_PATH = "/api/webhooks/aws-sms-events";

export const PROVISION_USAGE = `Uso: pnpm aws:provision --account <12 dígitos> [opções]

Por defeito só mostra o plano (nada é criado). Com --apply cria o que falta; nunca apaga
nem substitui recursos existentes, nunca envia SMS nem altera a identidade de origem.

  --account <id>              conta AWS esperada (obrigatório; verificada via STS)
  --region <região>           defeito: AWS_REGION
  --configuration-set <nome>  defeito: sms-app
  --topic <nome>              tópico SNS dos eventos de entrega; defeito: sms-delivery-events
  --countries PT[,ES…]        países permitidos na Protect Configuration; defeito: PT
  --webhook-url <https://…${WEBHOOK_PATH}>  subscrição HTTPS do tópico (opcional)
  --with-sqs                  cria a fila sms-jobs e a DLQ sms-jobs-dlq
  --alarm-topic-arn <arn>     cria os alarmes CloudWatch com notificação para este tópico
  --apply                     executa o plano`;

/** Argumentos da linha de comando (e AWS_REGION) → configuração validada. */
export function parseProvisionArgs(argv: string[], env: Record<string, string | undefined>): ParseResult {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { ok: false, error: `Argumento inesperado: ${arg}` };
    const key = arg.slice(2);
    if (["apply", "with-sqs", "help"].includes(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `Falta o valor de --${key}` };
    values.set(key, value);
    i += 1;
  }
  const known = new Set(["account", "region", "configuration-set", "topic", "countries", "webhook-url", "alarm-topic-arn"]);
  for (const key of values.keys()) if (!known.has(key)) return { ok: false, error: `Opção desconhecida: --${key}` };
  if (flags.has("help")) return { ok: false, error: PROVISION_USAGE };

  const account = values.get("account") ?? "";
  if (!ACCOUNT.test(account)) return { ok: false, error: "--account é obrigatório (12 dígitos)." };
  const region = values.get("region") ?? env.AWS_REGION ?? "";
  if (!REGION.test(region)) return { ok: false, error: "Região inválida: indica --region ou AWS_REGION." };

  const configurationSetName = values.get("configuration-set") ?? "sms-app";
  const topicName = values.get("topic") ?? "sms-delivery-events";
  for (const [label, name] of [["--configuration-set", configurationSetName], ["--topic", topicName]]) {
    if (!NAME.test(name)) return { ok: false, error: `${label} inválido (letras, números, _ e -, até 64).` };
  }

  const allowedCountries = [...new Set((values.get("countries") ?? "PT").split(",").map((c) => c.trim().toUpperCase()))];
  if (allowedCountries.length === 0 || allowedCountries.some((c) => !/^[A-Z]{2}$/.test(c))) {
    return { ok: false, error: "--countries: códigos ISO de 2 letras separados por vírgula (ex.: PT,ES)." };
  }

  const webhookUrl = values.get("webhook-url") ?? null;
  if (webhookUrl !== null) {
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      return { ok: false, error: "--webhook-url inválido." };
    }
    if (url.protocol !== "https:" || url.pathname !== WEBHOOK_PATH || ["localhost", "127.0.0.1"].includes(url.hostname)) {
      return { ok: false, error: `--webhook-url tem de ser https://<domínio público>${WEBHOOK_PATH}` };
    }
  }

  const alarmTopicArn = values.get("alarm-topic-arn") ?? null;
  if (alarmTopicArn !== null && !SNS_ARN.test(alarmTopicArn)) return { ok: false, error: "--alarm-topic-arn inválido." };
  if (alarmTopicArn !== null && alarmTopicArn.split(":")[3] !== region) {
    return { ok: false, error: "--alarm-topic-arn tem de estar na mesma região." };
  }

  return {
    ok: true,
    config: {
      account,
      region,
      configurationSetName,
      eventDestinationName: `${configurationSetName}-sns`,
      topicName,
      allowedCountries,
      webhookUrl,
      sqs: flags.has("with-sqs") ? { queueName: "sms-jobs", dlqName: "sms-jobs-dlq" } : null,
      alarmTopicArn,
      metricsNamespace: env.METRICS_EMF_NAMESPACE || "SmsApp",
      apply: flags.has("apply"),
    },
  };
}

// ---------------------------------------------------------------------------
// Estado atual e plano
// ---------------------------------------------------------------------------

export type DiscoveredState = {
  callerAccount: string;
  configurationSet: { exists: boolean; protectConfigurationId: string | null; eventDestinations: { name: string; topicArn: string | null }[] };
  /** Estado por país da Protect Configuration associada (null se ainda não existir). */
  countryRules: Record<string, string> | null;
  topic: { exists: boolean; allowsSmsVoice: boolean };
  subscriptionExists: boolean;
  sqs: { queueExists: boolean; dlqExists: boolean } | null;
  existingAlarms: string[];
};

export type ProvisionAction =
  | { kind: "create_protect_configuration" }
  | { kind: "update_country_rules"; updates: Record<string, "ALLOW" | "BLOCK"> }
  | { kind: "create_configuration_set" }
  | { kind: "associate_protect_configuration" }
  | { kind: "create_topic" }
  | { kind: "set_topic_policy" }
  | { kind: "create_event_destination" }
  | { kind: "subscribe_webhook"; url: string }
  | { kind: "create_dlq"; name: string }
  | { kind: "create_queue"; name: string; dlqName: string }
  | { kind: "create_alarm"; alarm: AlarmSpec };

export type PlanItem = { action: ProvisionAction | null; description: string };

export type AlarmSpec = {
  name: string;
  metric: string;
  comparison: "GreaterThanThreshold";
  threshold: number;
  periods: number;
  statistic: "Maximum" | "Average";
};

/** Alarmes sugeridos em docs/AWS_SETUP.md §13 (métricas EMF do worker, dimensão Mode). */
export const ALARMS: AlarmSpec[] = [
  { name: "sms-dlq-not-empty", metric: "DlqVisible", comparison: "GreaterThanThreshold", threshold: 0, periods: 1, statistic: "Maximum" },
  { name: "sms-campaign-halted", metric: "CampaignsPausedWithError", comparison: "GreaterThanThreshold", threshold: 0, periods: 1, statistic: "Maximum" },
  { name: "sms-throttled", metric: "Throttled15m", comparison: "GreaterThanThreshold", threshold: 0, periods: 3, statistic: "Maximum" },
  { name: "sms-recipients-stuck", metric: "RecipientsStuck", comparison: "GreaterThanThreshold", threshold: 0, periods: 2, statistic: "Maximum" },
  { name: "sms-provider-latency-p95", metric: "ProviderLatencyP95Ms", comparison: "GreaterThanThreshold", threshold: 5000, periods: 3, statistic: "Average" },
];

/** Diferenças para que só os países permitidos fiquem em ALLOW (todos os outros BLOCK). */
export function countryRuleUpdates(current: Record<string, string>, allowed: string[]): Record<string, "ALLOW" | "BLOCK"> {
  const updates: Record<string, "ALLOW" | "BLOCK"> = {};
  for (const [country, status] of Object.entries(current)) {
    const desired = allowed.includes(country) ? "ALLOW" : "BLOCK";
    if (status !== desired) updates[country] = desired;
  }
  // Um país permitido que a AWS não listou também é pedido explicitamente.
  for (const country of allowed) if (!(country in current)) updates[country] = "ALLOW";
  return updates;
}

/** Política do tópico: só o serviço de SMS desta conta pode publicar (evita confused deputy). */
export function topicPolicy(topicArn: string, account: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowSmsVoicePublish",
        Effect: "Allow",
        Principal: { Service: "sms-voice.amazonaws.com" },
        Action: "sns:Publish",
        Resource: topicArn,
        Condition: { StringEquals: { "aws:SourceAccount": account } },
      },
    ],
  });
}

export function topicArn(config: Pick<ProvisionConfig, "region" | "account" | "topicName">) {
  return `arn:aws:sns:${config.region}:${config.account}:${config.topicName}`;
}

export function queueUrl(config: Pick<ProvisionConfig, "region" | "account">, name: string) {
  return `https://sqs.${config.region}.amazonaws.com/${config.account}/${name}`;
}

export function queueArn(config: Pick<ProvisionConfig, "region" | "account">, name: string) {
  return `arn:aws:sqs:${config.region}:${config.account}:${name}`;
}

/**
 * Plano ordenado (as dependências vêm antes: Protect Configuration → Configuration Set →
 * associação; tópico → política → destino de eventos → subscrição; DLQ → fila).
 * Itens com `action: null` descrevem o que já existe.
 */
export function buildPlan(config: ProvisionConfig, state: DiscoveredState): PlanItem[] {
  const plan: PlanItem[] = [];
  const add = (action: ProvisionAction | null, description: string) => plan.push({ action, description });
  const cs = state.configurationSet;
  const arn = topicArn(config);

  if (!cs.protectConfigurationId) add({ kind: "create_protect_configuration" }, "Criar Protect Configuration (com proteção contra eliminação)");
  else add(null, `Protect Configuration já associada (${cs.protectConfigurationId})`);

  const updates = countryRuleUpdates(state.countryRules ?? {}, config.allowedCountries);
  if (state.countryRules === null) {
    add({ kind: "update_country_rules", updates: {} }, `Permitir apenas ${config.allowedCountries.join(", ")} (restantes países bloqueados)`);
  } else if (Object.keys(updates).length > 0) {
    const allow = Object.entries(updates).filter(([, s]) => s === "ALLOW").map(([c]) => c);
    add({ kind: "update_country_rules", updates }, `Regras de países: ${Object.keys(updates).length} alteração(ões)${allow.length ? ` (permitir ${allow.join(", ")})` : ""}`);
  } else add(null, `Regras de países já corretas (apenas ${config.allowedCountries.join(", ")})`);

  if (!cs.exists) add({ kind: "create_configuration_set" }, `Criar Configuration Set "${config.configurationSetName}"`);
  else add(null, `Configuration Set "${config.configurationSetName}" já existe`);
  if (!cs.protectConfigurationId) add({ kind: "associate_protect_configuration" }, "Associar a Protect Configuration ao Configuration Set");

  if (!state.topic.exists) add({ kind: "create_topic" }, `Criar tópico SNS "${config.topicName}"`);
  else add(null, `Tópico SNS "${config.topicName}" já existe`);
  if (!state.topic.allowsSmsVoice) add({ kind: "set_topic_policy" }, "Política do tópico: só sms-voice.amazonaws.com desta conta pode publicar");
  else add(null, "Política do tópico já permite o serviço de SMS");

  const destination = cs.eventDestinations.find((d) => d.name === config.eventDestinationName);
  if (!destination) add({ kind: "create_event_destination" }, `Criar destino de eventos "${config.eventDestinationName}" (TEXT_ALL → SNS)`);
  else if (destination.topicArn !== arn) {
    add(null, `ATENÇÃO: o destino "${config.eventDestinationName}" existe mas aponta para outro tópico (${destination.topicArn ?? "—"}); não é alterado`);
  } else add(null, `Destino de eventos "${config.eventDestinationName}" já existe`);

  if (config.webhookUrl) {
    if (!state.subscriptionExists) add({ kind: "subscribe_webhook", url: config.webhookUrl }, `Subscrever ${config.webhookUrl} (a aplicação confirma sozinha se já estiver publicada com AWS_SMS_EVENTS_SNS_TOPIC_ARN=${arn})`);
    else add(null, "Subscrição HTTPS do webhook já existe");
  } else add(null, "Sem --webhook-url: o tópico fica sem subscrição (eventos de entrega não chegam à aplicação)");

  if (config.sqs && state.sqs) {
    if (!state.sqs.dlqExists) add({ kind: "create_dlq", name: config.sqs.dlqName }, `Criar DLQ "${config.sqs.dlqName}" (SSE, retenção 14 dias)`);
    else add(null, `DLQ "${config.sqs.dlqName}" já existe`);
    if (!state.sqs.queueExists) {
      add({ kind: "create_queue", name: config.sqs.queueName, dlqName: config.sqs.dlqName }, `Criar fila "${config.sqs.queueName}" (SSE, visibilidade 60 s, DLQ após 5 receções)`);
    } else add(null, `Fila "${config.sqs.queueName}" já existe`);
  }

  if (config.alarmTopicArn) {
    for (const alarm of ALARMS) {
      if (state.existingAlarms.includes(alarm.name)) add(null, `Alarme "${alarm.name}" já existe (não é alterado)`);
      else add({ kind: "create_alarm", alarm }, `Criar alarme "${alarm.name}" (${alarm.metric} > ${alarm.threshold})`);
    }
  }
  return plan;
}

/** Variáveis a colocar no ambiente da aplicação depois de aplicar (sem segredos). */
export function envOutput(config: ProvisionConfig, protectConfigurationId: string | null): string[] {
  const lines = [
    `AWS_REGION=${config.region}`,
    `AWS_SMS_CONFIGURATION_SET=${config.configurationSetName}`,
    `AWS_SMS_PROTECT_CONFIGURATION_ID=${protectConfigurationId ?? "<criado ao aplicar>"}`,
    `AWS_SMS_EVENTS_SNS_TOPIC_ARN=${topicArn(config)}`,
  ];
  if (config.sqs) {
    lines.push(
      "SMS_JOB_QUEUE=sqs",
      `AWS_SQS_SMS_JOBS_QUEUE_URL=${queueUrl(config, config.sqs.queueName)}`,
      `AWS_SQS_SMS_JOBS_DLQ_URL=${queueUrl(config, config.sqs.dlqName)}`,
    );
  }
  return lines;
}
