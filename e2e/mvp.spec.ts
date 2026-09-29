import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN, E2E_VIEWER } from "./global-setup";

// Fluxos do CLAUDE.md §33: login, contacto, template, envio dry-run, histórico,
// campanha, confirmação e bloqueio de opt-out. Tudo com o provider fake.
test.describe.configure({ mode: "serial" });

async function login(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await page.fill("input[name=email]", user.email);
  await page.fill("input[name=password]", user.password);
  await page.click("button");
  await page.waitForURL("**/dashboard");
}

async function createContact(page: Page, name: string, phone: string, consent: "OPTED_IN" | "UNKNOWN" | "OPTED_OUT") {
  await page.goto("/contacts");
  const form = page.locator("main form").filter({ hasText: "Novo contacto" });
  await form.locator("input[name=name]").fill(name);
  await form.locator("input[name=phone]").fill(phone);
  await form.locator("select[name=consentStatus]").selectOption(consent);
  if (consent === "OPTED_IN") {
    await form.locator("input[name=consentSource]").fill("loja");
    await form.locator("input[name=consentPurpose]").fill("marketing");
  }
  await form.locator("button").click();
  await page.waitForURL(/\/contacts\/[a-z0-9]+/);
  await expect(page.locator("main [role=status]")).toContainText("Contacto criado");
}

test("login, contactos, lista e template", async ({ page }) => {
  await login(page, E2E_ADMIN);
  await expect(page.getByText("MODO DE TESTE — nenhum SMS real será enviado")).toBeVisible();

  await createContact(page, "Maria Silva", "912345678", "OPTED_IN");
  await createContact(page, "Rui Costa", "913456789", "OPTED_IN");
  await createContact(page, "Ana Sem", "914567890", "UNKNOWN");
  await createContact(page, "João Fora", "915678901", "OPTED_OUT");

  await page.goto("/lists");
  await page.fill("main input[name=name]", "Clientes E2E");
  await page.locator("main form button").first().click();
  await page.waitForURL(/\/lists\/[a-z0-9]+/);
  const phones = ["912345678", "913456789", "914567890", "915678901"];
  for (const [index, phone] of phones.entries()) {
    await page.fill("main form input[name=phone]", phone);
    await page.getByRole("button", { name: "Adicionar" }).click();
    await expect(page.locator("main table tbody tr")).toHaveCount(index + 1);
    await page.waitForLoadState("networkidle");
  }

  await page.goto("/templates/new");
  await page.locator("main label", { hasText: "Nome" }).locator("input").fill("Aviso E2E");
  await page.getByLabel("Transacional").check();
  await page.fill("#template-body", "Ola {{firstName}}, a loja abre dia {{date}}.");
  await page.getByRole("button", { name: "Criar template" }).click();
  await expect(page.locator("main [role=status]")).toContainText("Template criado");
});

test("envio individual em dry-run e bloqueio de opt-out", async ({ page }) => {
  await login(page, E2E_ADMIN);
  await page.goto("/send");
  await page.locator("main label", { hasText: "Destinatário" }).locator("input").fill("912345678");
  await page.locator("input[type=radio][value=TRANSACTIONAL]").check();
  await page.locator("textarea").fill("Teste E2E");
  await page.getByRole("button", { name: "Rever envio" }).click();
  await expect(page.getByText("+351912345678")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar e enviar" }).click();
  await expect(page.locator("main [role=status]")).toContainText("MODO DE TESTE");

  await page.locator("main label", { hasText: "Destinatário" }).locator("input").fill("915678901");
  await page.locator("input[type=radio][value=TRANSACTIONAL]").check();
  await page.locator("textarea").fill("Não deve sair");
  await page.getByRole("button", { name: "Rever envio" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("opt-out");

  await page.goto("/messages");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("+351******678");
});

test("campanha: revisão §29, 2.ª confirmação, envio até concluir", async ({ page }) => {
  await login(page, E2E_ADMIN);
  await page.goto("/campaigns/new");
  await page.locator("main label", { hasText: "Nome da campanha" }).locator("input").fill("Abertura E2E");
  await page.locator("main label", { hasText: "Lista de destinatários" }).locator("select").selectOption({ label: "Clientes E2E (4 contactos)" });
  await page.locator("main label", { hasText: "Template" }).locator("select").selectOption({ label: "Aviso E2E (Transacional)" });
  await page.locator("main label", { hasText: "Data" }).locator("input").fill("15/10");
  await page.getByRole("button", { name: "Criar rascunho" }).click();
  await page.waitForURL(/\/campaigns\/[a-z0-9]+/);

  const summary = page.getByRole("region", { name: "Resumo antes do envio" });
  await expect(summary).toContainText("Destinatários elegíveis2");
  await expect(summary).toContainText("Excluídos por opt-out1");
  await expect(summary).toContainText("Sem consentimento1");
  await expect(summary).toContainText("ModoTESTE");
  // §10: número normalizado completo visível para quem pode enviar.
  await expect(summary).toContainText("+351912345678");
  await expect(summary).toContainText("Ola Maria, a loja abre dia 15/10.");
  await expect(page.getByText("MODO DE TESTE — nenhum SMS real será enviado")).toBeVisible();

  const confirmButton = page.getByRole("button", { name: "Confirmar e enviar" });
  await expect(confirmButton).toBeDisabled();
  await page.locator("main label", { hasText: "escreve" }).locator("input").fill("ENVIAR 2 SMS");
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  const progress = page.getByRole("region", { name: "Progresso da campanha" });
  await expect(progress).toContainText("Concluída", { timeout: 30_000 });
  await expect(progress.locator("[data-status=ACCEPTED]")).toHaveText("2");

  await page.getByRole("link", { name: /Ver mensagens enviadas/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody")).not.toContainText("+351******901");
});

test("VIEWER vê campanhas sem controlos de envio", async ({ page }) => {
  await login(page, E2E_VIEWER);
  await page.goto("/campaigns");
  await expect(page.getByText("Nova campanha")).toHaveCount(0);
  await page.getByRole("link", { name: "Abertura E2E" }).click();
  await expect(page.getByRole("region", { name: "Progresso da campanha" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Iniciar|Continuar|Retomar|Cancelar/ })).toHaveCount(0);
});

test("eventos de entrega: endpoint desativado sem tópico e aviso no dashboard", async ({ page, request }) => {
  const response = await request.post("/api/webhooks/aws-sms-events", { data: "{}" });
  expect(response.status()).toBe(404);
  await login(page, E2E_ADMIN);
  await expect(page.getByText("Eventos de entrega ainda não configurados")).toBeVisible();
});

test("headers de segurança e prontidão", async ({ request }) => {
  const response = await request.get("/login");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-powered-by"]).toBeUndefined();
  const ready = await request.get("/api/health/ready");
  expect(await ready.json()).toEqual({ status: "ok" });
});

test("login bloqueado após tentativas falhadas, sem revelar a conta", async ({ page }) => {
  for (let i = 0; i < 5; i += 1) {
    await page.goto("/login");
    await page.fill("input[name=email]", E2E_VIEWER.email);
    await page.fill("input[name=password]", "errada-errada");
    await page.click("button");
    await expect(page.locator("main")).toContainText("Credenciais inválidas");
  }
  await page.goto("/login");
  await page.fill("input[name=email]", E2E_VIEWER.email);
  await page.fill("input[name=password]", E2E_VIEWER.password);
  await page.click("button");
  await expect(page.locator("main")).toContainText("Demasiadas tentativas");
});
