import { createHash } from "node:crypto";
import {
  buildPlan,
  envOutput,
  queueArn,
  topicArn,
  topicPolicy,
  type AlarmSpec,
  type DiscoveredState,
  type PlanItem,
  type ProvisionConfig,
} from "@/features/aws-provision/plan";

/** Operações AWS usadas (o adaptador real está em src/lib/aws/provision-adapter.ts). Nunca apaga. */
export interface AwsProvisionPort {
  callerAccount(): Promise<string>;
  discover(config: ProvisionConfig): Promise<Omit<DiscoveredState, "callerAccount">>;
  createProtectConfiguration(clientToken: string): Promise<string>;
  getCountryRules(protectConfigurationId: string): Promise<Record<string, string>>;
  updateCountryRules(protectConfigurationId: string, updates: Record<string, "ALLOW" | "BLOCK">): Promise<void>;
  createConfigurationSet(name: string): Promise<void>;
  associateProtectConfiguration(protectConfigurationId: string, configurationSetName: string): Promise<void>;
  createTopic(name: string): Promise<string>;
  setTopicPolicy(topicArn: string, policy: string): Promise<void>;
  createEventDestination(configurationSetName: string, destinationName: string, topicArn: string): Promise<void>;
  subscribe(topicArn: string, url: string): Promise<void>;
  createQueue(name: string, attributes: Record<string, string>): Promise<void>;
  putAlarm(alarm: AlarmSpec, namespace: string, notifyTopicArn: string): Promise<void>;
}

export type ProvisionResult =
  | { ok: false; error: string }
  | { ok: true; applied: boolean; plan: PlanItem[]; env: string[] };

/** Atualizações de países em lotes (pedidos pequenos; cada lote é independente). */
const COUNTRY_BATCH = 25;

/** Token determinístico: repetir após uma falha a meio devolve a mesma Protect Configuration. */
export function protectClientToken(config: Pick<ProvisionConfig, "account" | "region" | "configurationSetName">) {
  return createHash("sha256").update(`${config.account}:${config.region}:${config.configurationSetName}`).digest("hex").slice(0, 64);
}

/**
 * Descobre o estado, calcula o plano e (só com `apply`) cria o que falta, pela ordem das
 * dependências. Recusa correr se as credenciais pertencerem a outra conta.
 */
export async function runProvision(
  config: ProvisionConfig,
  port: AwsProvisionPort,
  log: (line: string) => void = () => {},
): Promise<ProvisionResult> {
  const caller = await port.callerAccount();
  if (caller !== config.account) {
    return { ok: false, error: `As credenciais pertencem à conta ${caller}, não à conta indicada (${config.account}). Nada foi feito.` };
  }
  const state: DiscoveredState = { callerAccount: caller, ...(await port.discover(config)) };
  const plan = buildPlan(config, state);
  let protectId = state.configurationSet.protectConfigurationId;
  if (!config.apply) return { ok: true, applied: false, plan, env: envOutput(config, protectId) };

  const arn = topicArn(config);
  for (const item of plan) {
    const action = item.action;
    if (!action) continue;
    log(`→ ${item.description}`);
    switch (action.kind) {
      case "create_protect_configuration":
        protectId = await port.createProtectConfiguration(protectClientToken(config));
        break;
      case "update_country_rules": {
        if (!protectId) throw new Error("Protect Configuration em falta");
        // Protect Configuration acabada de criar: calcular a partir das regras reais da AWS.
        const updates = Object.keys(action.updates).length
          ? action.updates
          : buildPlan(config, { ...state, countryRules: await port.getCountryRules(protectId) })
              .map((p) => p.action)
              .find((a) => a?.kind === "update_country_rules")?.updates ?? {};
        const entries = Object.entries(updates as Record<string, "ALLOW" | "BLOCK">);
        // ALLOW primeiro: nunca há um instante com os países permitidos bloqueados por engano.
        entries.sort(([, a], [, b]) => (a === b ? 0 : a === "ALLOW" ? -1 : 1));
        for (let i = 0; i < entries.length; i += COUNTRY_BATCH) {
          await port.updateCountryRules(protectId, Object.fromEntries(entries.slice(i, i + COUNTRY_BATCH)));
        }
        break;
      }
      case "create_configuration_set":
        await port.createConfigurationSet(config.configurationSetName);
        break;
      case "associate_protect_configuration":
        if (!protectId) throw new Error("Protect Configuration em falta");
        await port.associateProtectConfiguration(protectId, config.configurationSetName);
        break;
      case "create_topic":
        await port.createTopic(config.topicName);
        break;
      case "set_topic_policy":
        await port.setTopicPolicy(arn, topicPolicy(arn, config.account));
        break;
      case "create_event_destination":
        await port.createEventDestination(config.configurationSetName, config.eventDestinationName, arn);
        break;
      case "subscribe_webhook":
        await port.subscribe(arn, action.url);
        break;
      case "create_dlq":
        await port.createQueue(action.name, { SqsManagedSseEnabled: "true", MessageRetentionPeriod: "1209600" });
        break;
      case "create_queue":
        await port.createQueue(action.name, {
          SqsManagedSseEnabled: "true",
          VisibilityTimeout: "60",
          ReceiveMessageWaitTimeSeconds: "20",
          MessageRetentionPeriod: "86400",
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: queueArn(config, action.dlqName), maxReceiveCount: "5" }),
        });
        break;
      case "create_alarm":
        if (!config.alarmTopicArn) throw new Error("Tópico de alarmes em falta");
        await port.putAlarm(action.alarm, config.metricsNamespace, config.alarmTopicArn);
        break;
    }
  }
  return { ok: true, applied: true, plan, env: envOutput(config, protectId) };
}
