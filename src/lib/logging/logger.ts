/**
 * Logging estruturado (JSON por linha).
 *
 * Os campos permitidos são explícitos para evitar, por construção, registar o corpo
 * da mensagem, números completos, credenciais ou tokens. Telefones devem chegar já
 * mascarados (`maskPhoneNumber`).
 */
export type LogFields = {
  messageInternalId?: string;
  awsMessageId?: string;
  campaignId?: string;
  userId?: string;
  status?: string;
  durationMs?: number;
  errorCode?: string;
  providerErrorName?: string;
  providerRequestId?: string;
  provider?: string;
  dryRun?: boolean;
  retryable?: boolean;
  uncertain?: boolean;
  segments?: number;
  maskedDestination?: string;
  /** Entregas da mesma mensagem SQS (ApproximateReceiveCount). */
  receiveCount?: number;
};

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

export const consoleLogger: Logger = {
  log(level, event, fields = {}) {
    const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  },
};

/** Logger que guarda as entradas em memória (testes). */
export function createMemoryLogger() {
  const entries: Array<{ level: LogLevel; event: string; fields: LogFields }> = [];
  const logger: Logger = {
    log(level, event, fields = {}) {
      entries.push({ level, event, fields });
    },
  };
  return { logger, entries };
}
