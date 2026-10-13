/**
 * Provisionamento dos recursos AWS: `pnpm aws:provision --account <id> [--apply]`.
 * Sem --apply só mostra o plano. Nunca apaga, nunca envia SMS, nunca altera a identidade de origem.
 */
import "dotenv/config";
import { parseProvisionArgs } from "@/features/aws-provision/plan";
import { createAwsProvisionAdapter } from "@/lib/aws/provision-adapter";
import { runProvision } from "@/server/services/aws-provision";

async function main() {
  const parsed = parseProvisionArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  const { config } = parsed;
  console.info(`Conta ${config.account} · região ${config.region} · modo ${config.apply ? "APLICAR" : "PLANO (nada é criado)"}`);
  try {
    const result = await runProvision(config, createAwsProvisionAdapter(config.region), (line) => console.info(line));
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.info(result.applied ? "\nAplicado:" : "\nPlano:");
    for (const item of result.plan) console.info(`${item.action ? (result.applied ? "  ✔ " : "  + ") : "  = "}${item.description}`);
    if (!result.applied && result.plan.some((i) => i.action)) console.info("\nPara executar, repete com --apply.");
    console.info("\nVariáveis para o ambiente da aplicação:");
    for (const line of result.env) console.info(`  ${line}`);
  } catch (error) {
    // Nunca imprimir credenciais: só o tipo e a mensagem do erro da AWS.
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message.slice(0, 300) : "";
    const hint = config.apply ? " Os passos já concluídos mantêm-se; repetir é seguro." : " Nada foi criado.";
    const credentials = ["InvalidClientTokenId", "ExpiredToken", "CredentialsProviderError", "UnrecognizedClientException"].includes(name)
      ? " Verifica as credenciais AWS (IAM Role, SSO ou variáveis de ambiente)."
      : "";
    console.error(`Falhou: ${name}${message ? ` — ${message.replace(/\.$/, "")}` : ""}.${credentials}${hint}`);
    process.exitCode = 1;
  }
}

void main();
