import { CloudWatchClient, DescribeAlarmsCommand, PutMetricAlarmCommand } from "@aws-sdk/client-cloudwatch";
import {
  AssociateProtectConfigurationCommand,
  CreateConfigurationSetCommand,
  CreateEventDestinationCommand,
  CreateProtectConfigurationCommand,
  DescribeConfigurationSetsCommand,
  GetProtectConfigurationCountryRuleSetCommand,
  PinpointSMSVoiceV2Client,
  UpdateProtectConfigurationCountryRuleSetCommand,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import {
  CreateTopicCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { CreateQueueCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ALARMS, topicArn, type ProvisionConfig } from "@/features/aws-provision/plan";
import type { AwsProvisionPort } from "@/server/services/aws-provision";

const TAGS = [
  { Key: "Project", Value: "caetano-sms" },
  { Key: "ManagedBy", Value: "aws-provision" },
];
const NOT_FOUND = new Set(["ResourceNotFoundException", "NotFoundException", "NotFound", "QueueDoesNotExist"]);

function isNotFound(error: unknown) {
  return error instanceof Error && NOT_FOUND.has(error.name);
}

/** A política atual já dá sns:Publish ao serviço de SMS, restrito a esta conta? */
function policyAllowsSmsVoice(policy: string | undefined, account: string) {
  if (!policy) return false;
  try {
    const statements = (JSON.parse(policy).Statement ?? []) as Array<Record<string, unknown>>;
    return statements.some((s) => {
      const principal = (s.Principal as { Service?: string | string[] } | undefined)?.Service;
      const services = Array.isArray(principal) ? principal : [principal];
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      const source = (s.Condition as { StringEquals?: Record<string, string> } | undefined)?.StringEquals?.["aws:SourceAccount"];
      return s.Effect === "Allow" && services.includes("sms-voice.amazonaws.com") && actions.includes("sns:Publish") && source === account;
    });
  } catch {
    return false;
  }
}

/** Adaptador real (credenciais pela cadeia normal do SDK: IAM Role, SSO ou variáveis). */
export function createAwsProvisionAdapter(region: string): AwsProvisionPort {
  const opts = { region, maxAttempts: 3 };
  const sms = new PinpointSMSVoiceV2Client(opts);
  const sns = new SNSClient(opts);
  const sqs = new SQSClient(opts);
  const cw = new CloudWatchClient(opts);
  const sts = new STSClient(opts);

  return {
    async callerAccount() {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      return identity.Account ?? "";
    },

    async discover(config: ProvisionConfig) {
      let configurationSet: Awaited<ReturnType<AwsProvisionPort["discover"]>>["configurationSet"] = {
        exists: false,
        protectConfigurationId: null,
        eventDestinations: [],
      };
      try {
        const result = await sms.send(new DescribeConfigurationSetsCommand({ ConfigurationSetNames: [config.configurationSetName] }));
        const set = result.ConfigurationSets?.[0];
        if (set) {
          configurationSet = {
            exists: true,
            protectConfigurationId: set.ProtectConfigurationId ?? null,
            eventDestinations: (set.EventDestinations ?? []).map((d) => ({ name: d.EventDestinationName ?? "", topicArn: d.SnsDestination?.TopicArn ?? null })),
          };
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      let countryRules: Record<string, string> | null = null;
      if (configurationSet.protectConfigurationId) countryRules = await this.getCountryRules(configurationSet.protectConfigurationId);

      const arn = topicArn(config);
      let topic = { exists: false, allowsSmsVoice: false };
      let subscriptionExists = false;
      try {
        const attrs = await sns.send(new GetTopicAttributesCommand({ TopicArn: arn }));
        topic = { exists: true, allowsSmsVoice: policyAllowsSmsVoice(attrs.Attributes?.Policy, config.account) };
        if (config.webhookUrl) {
          let token: string | undefined;
          do {
            const page = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: token }));
            if ((page.Subscriptions ?? []).some((s) => s.Protocol === "https" && s.Endpoint === config.webhookUrl)) subscriptionExists = true;
            token = page.NextToken;
          } while (token && !subscriptionExists);
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      let queues: { queueExists: boolean; dlqExists: boolean } | null = null;
      if (config.sqs) {
        const exists = async (name: string) => {
          try {
            await sqs.send(new GetQueueUrlCommand({ QueueName: name, QueueOwnerAWSAccountId: config.account }));
            return true;
          } catch (error) {
            if (isNotFound(error)) return false;
            throw error;
          }
        };
        queues = { queueExists: await exists(config.sqs.queueName), dlqExists: await exists(config.sqs.dlqName) };
      }

      const existingAlarms = config.alarmTopicArn
        ? ((await cw.send(new DescribeAlarmsCommand({ AlarmNames: ALARMS.map((a) => a.name) }))).MetricAlarms ?? []).map((a) => a.AlarmName ?? "")
        : [];

      return { configurationSet, countryRules, topic, subscriptionExists, sqs: queues, existingAlarms };
    },

    async createProtectConfiguration(clientToken) {
      const result = await sms.send(new CreateProtectConfigurationCommand({ ClientToken: clientToken, DeletionProtectionEnabled: true, Tags: TAGS }));
      if (!result.ProtectConfigurationId) throw new Error("A AWS não devolveu o ID da Protect Configuration");
      return result.ProtectConfigurationId;
    },

    async getCountryRules(protectConfigurationId) {
      const result = await sms.send(new GetProtectConfigurationCountryRuleSetCommand({ ProtectConfigurationId: protectConfigurationId, NumberCapability: "SMS" }));
      return Object.fromEntries(Object.entries(result.CountryRuleSet ?? {}).map(([country, rule]) => [country, rule.ProtectStatus ?? ""]));
    },

    async updateCountryRules(protectConfigurationId, updates) {
      await sms.send(
        new UpdateProtectConfigurationCountryRuleSetCommand({
          ProtectConfigurationId: protectConfigurationId,
          NumberCapability: "SMS",
          CountryRuleSetUpdates: Object.fromEntries(Object.entries(updates).map(([country, status]) => [country, { ProtectStatus: status }])),
        }),
      );
    },

    async createConfigurationSet(name) {
      await sms.send(new CreateConfigurationSetCommand({ ConfigurationSetName: name, Tags: TAGS }));
    },

    async associateProtectConfiguration(protectConfigurationId, configurationSetName) {
      await sms.send(new AssociateProtectConfigurationCommand({ ProtectConfigurationId: protectConfigurationId, ConfigurationSetName: configurationSetName }));
    },

    async createTopic(name) {
      const result = await sns.send(new CreateTopicCommand({ Name: name, Tags: TAGS }));
      return result.TopicArn ?? "";
    },

    async setTopicPolicy(arn, policy) {
      await sns.send(new SetTopicAttributesCommand({ TopicArn: arn, AttributeName: "Policy", AttributeValue: policy }));
    },

    async createEventDestination(configurationSetName, destinationName, arn) {
      await sms.send(
        new CreateEventDestinationCommand({
          ConfigurationSetName: configurationSetName,
          EventDestinationName: destinationName,
          MatchingEventTypes: ["TEXT_ALL"],
          SnsDestination: { TopicArn: arn },
        }),
      );
    },

    async subscribe(arn, url) {
      await sns.send(new SubscribeCommand({ TopicArn: arn, Protocol: "https", Endpoint: url, ReturnSubscriptionArn: true }));
    },

    async createQueue(name, attributes) {
      await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes, tags: Object.fromEntries(TAGS.map((t) => [t.Key, t.Value])) }));
    },

    async putAlarm(alarm, namespace, notifyTopicArn) {
      await cw.send(
        new PutMetricAlarmCommand({
          AlarmName: alarm.name,
          Namespace: namespace,
          MetricName: alarm.metric,
          Dimensions: [{ Name: "Mode", Value: "PRODUCTION" }],
          Statistic: alarm.statistic,
          Period: 300,
          EvaluationPeriods: alarm.periods,
          Threshold: alarm.threshold,
          ComparisonOperator: alarm.comparison,
          TreatMissingData: "notBreaching",
          AlarmActions: [notifyTopicArn],
          Tags: TAGS,
        }),
      );
    },
  };
}
