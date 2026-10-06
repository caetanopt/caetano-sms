import { expect, test, type Cookie, type Page } from "@playwright/test";
import { base32Decode, totp } from "../src/features/auth/totp";
import { decodeQrPath } from "../tests/helpers/qr-decode";
import { E2E_METRICS_TOKEN } from "../playwright.config";
import { E2E_ADMIN, E2E_ADMIN_TOTP_SECRET, E2E_OPERATOR, E2E_VIEWER } from "./global-setup";

// Fluxos do CLAUDE.md §33: login, contacto, template, envio dry-run, histórico,
// campanha, confirmação e bloqueio de opt-out. Tudo com o provider fake.
test.describe.configure({ mode: "serial" });

/** Código TOTP de um passo ainda não usado (o servidor rejeita reutilizações). */
let lastTotpStep = 0;
async function freshTotp(secretBase32: string) {
  while (Math.floor(Date.now() / 30_000) <= lastTotpStep) await new Promise((resolve) => setTimeout(resolve, 500));
  lastTotpStep = Math.floor(Date.now() / 30_000);
  return totp(base32Decode(secretBase32), new Date());
}

// Sessões reutilizadas entre testes: evita repetir o 2FA (e esperar por um novo passo TOTP).
const sessions = new Map<string, Cookie[]>();

async function login(page: Page, user: { email: string; password: string }) {
  const cached = sessions.get(user.email);
  if (cached) {
    await page.context().addCookies(cached);
    await page.goto("/dashboard");
    if (new URL(page.url()).pathname === "/dashboard") return;
    sessions.delete(user.email);
  }
  await page.goto("/login");
  await page.fill("input[name=email]", user.email);
  await page.fill("input[name=password]", user.password);
  await page.click("button");
  await page.waitForURL(/\/(dashboard|login\/mfa)$/);
  if (page.url().endsWith("/login/mfa")) {
    await page.fill("input[name=code]", await freshTotp(E2E_ADMIN_TOTP_SECRET));
    await page.getByRole("button", { name: "Verificar" }).click();
    await page.waitForURL("**/dashboard");
  }
  sessions.set(user.email, await page.context().cookies());
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
    // O React repõe o formulário quando a ação anterior termina; se isso acontecer depois do
    // preenchimento, o campo fica vazio. Repetir é seguro: adicionar um membro é idempotente.
    await expect(async () => {
      await page.fill("main form input[name=phone]", phone);
      await page.getByRole("button", { name: "Adicionar" }).click();
      await expect(page.locator("main table tbody tr")).toHaveCount(index + 1, { timeout: 2000 });
    }).toPass({ timeout: 15000 });
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
  await page.waitForURL(/\/campaigns\/(?!new\b)[a-z0-9]+/);

  // Mensagem de uso único: visível após criar, mas retirada do URL para não "colar" a estados seguintes.
  const draftNotice = page.locator("main [role=status]").filter({ hasText: "Rascunho criado" });
  await expect(draftNotice).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]success=/);
  await page.waitForLoadState("networkidle");
  await expect(draftNotice).toBeVisible();

  const summary = page.getByRole("region", { name: "Resumo antes do envio" });
  await expect(summary).toContainText("Destinatários elegíveis2");
  await expect(summary).toContainText("Excluídos por opt-out1");
  await expect(summary).toContainText("Sem consentimento1");
  await expect(summary).toContainText("ModoTESTE");
  await expect(summary).toContainText("Ritmo máximo60 mensagens/minuto (limite global)");
  await expect(summary).toContainText("Quota diária de quem confirma");
  await expect(summary).toContainText("Duração mínima estimada2 s (estimativa pelos limites internos)");
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
  await expect(page.getByText("Rascunho criado")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Progresso da campanha" })).toContainText("Concluída");
  await expect(page.getByText("Rascunho criado")).toHaveCount(0);

  await page.getByRole("link", { name: /Ver mensagens enviadas/ }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody")).not.toContainText("+351******901");
});

test("ritmo por campanha: acima do global é rejeitado; abaixo aparece na revisão", async ({ page }) => {
  await login(page, E2E_ADMIN);
  await page.goto("/campaigns/new");
  await page.locator("main label", { hasText: "Nome da campanha" }).locator("input").fill("Ritmo E2E");
  await page.locator("main label", { hasText: "Lista de destinatários" }).locator("select").selectOption({ label: "Clientes E2E (4 contactos)" });
  await page.locator("input[type=radio][value=TRANSACTIONAL]").check();
  await page.locator("main textarea").fill("Ola, ritmo controlado.");
  const pace = page.locator("main label", { hasText: "Ritmo máximo" }).locator("input");
  await pace.fill("999");
  // 1.ª barreira: o browser (max = limite global); 2.ª: o servidor, mesmo sem o atributo.
  expect(await pace.evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true);
  await pace.evaluate((el: HTMLInputElement) => el.removeAttribute("max"));
  await page.getByRole("button", { name: "Criar rascunho" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("não pode exceder o limite global (60 mensagens por minuto)");
  await pace.fill("30");
  await page.getByRole("button", { name: "Criar rascunho" }).click();
  await page.waitForURL(/\/campaigns\/[a-z0-9]+/);
  const summary = page.getByRole("region", { name: "Resumo antes do envio" });
  await expect(summary).toContainText("Ritmo máximo30 mensagens/minuto (definido nesta campanha; global 60)");
  // 2 mensagens a 30/min → 4 s (domina os 2 s do MPS).
  await expect(summary).toContainText("Duração mínima estimada4 s");
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

test("ícones da marca servidos sem sessão e anunciados no head", async ({ page, request }) => {
  await page.goto("/login");
  const svgIcon = page.locator('head link[rel="icon"][type="image/svg+xml"]');
  await expect(svgIcon).toHaveCount(1);
  await expect(page.locator('head link[rel="apple-touch-icon"][sizes="180x180"]')).toHaveCount(1);

  for (const [path, type] of [
    [(await svgIcon.getAttribute("href"))!, "image/svg+xml"],
    ["/favicon.ico", "image/x-icon"],
    [(await page.locator('head link[rel="apple-touch-icon"]').getAttribute("href"))!, "image/png"],
  ]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toContain(type);
  }
});

test("observabilidade: página só para ADMIN e métricas Prometheus com token", async ({ page, request }) => {
  await login(page, E2E_ADMIN);
  await page.getByRole("link", { name: "Observabilidade" }).click();
  await expect(page.getByRole("heading", { name: "Observabilidade" })).toBeVisible();
  // Mensagens das fases anteriores (dry-run) aparecem na janela de 24 h.
  const sends = page.getByRole("region", { name: "Envios por janela" });
  await expect(sends.getByRole("row", { name: /24 horas/ })).toBeVisible();
  await expect(page.getByText("fila direta (sem SQS)")).toBeVisible();

  expect((await request.get("/api/metrics")).status()).toBe(401);
  const metrics = await request.get("/api/metrics", { headers: { authorization: `Bearer ${E2E_METRICS_TOKEN}` } });
  expect(metrics.status()).toBe(200);
  const body = await metrics.text();
  expect(body).toContain('sms_app_info{mode="TEST",provider="fake",queue="direct"} 1');
  expect(body).toMatch(/sms_messages_window\{window="24h",outcome="accepted"\} [1-9]/);
  expect(body).not.toMatch(/\+351/);
});

test("VIEWER não acede à observabilidade", async ({ page }) => {
  await login(page, E2E_VIEWER);
  await expect(page.getByRole("link", { name: "Observabilidade" })).toHaveCount(0);
  await page.goto("/observability");
  await page.waitForURL("**/dashboard");
});

test("gestão de utilizadores: criar, palavra-passe temporária obrigatória, desativar", async ({ page, browser }) => {
  await login(page, E2E_ADMIN);
  await page.getByRole("link", { name: "Utilizadores" }).click();
  await page.fill("main input[name=name]", "Operador Novo");
  await page.fill("main input[name=email]", "novo.operador@example.com");
  await page.selectOption("main select[name=role]", "OPERATOR");
  await page.getByRole("button", { name: "Criar utilizador" }).click();
  const temporary = (await page.getByTestId("temporary-password").textContent())?.trim() ?? "";
  expect(temporary.length).toBeGreaterThanOrEqual(12);
  await expect(page.locator("main table")).toContainText("Palavra-passe temporária");
  expect(page.url()).not.toContain(temporary);

  // O novo utilizador é obrigado a alterar a palavra-passe antes de usar a aplicação.
  const other = await browser.newContext();
  const userPage = await other.newPage();
  await userPage.goto("/login");
  await userPage.fill("input[name=email]", "novo.operador@example.com");
  await userPage.fill("input[name=password]", temporary);
  await userPage.click("button");
  await userPage.waitForURL("**/account/password");
  await userPage.goto("/campaigns");
  await userPage.waitForURL("**/account/password");
  await userPage.fill("input[name=currentPassword]", temporary);
  await userPage.fill("input[name=newPassword]", "uma frase bem longa e segura");
  await userPage.fill("input[name=confirmPassword]", "uma frase bem longa e segura");
  await userPage.getByRole("button", { name: "Alterar palavra-passe" }).click();
  await expect(userPage.getByRole("status")).toContainText("Palavra-passe alterada");
  await userPage.goto("/dashboard");
  await expect(userPage.getByRole("link", { name: "Utilizadores" })).toHaveCount(0);
  await userPage.goto("/users");
  await userPage.waitForURL("**/dashboard");

  // Desativar termina a sessão aberta do utilizador.
  await page.goto("/users");
  await page.getByRole("link", { name: "Operador Novo" }).click();
  await page.selectOption("main select[name=isActive]", "false");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator("main [role=status]")).toContainText("Utilizador atualizado");
  await userPage.goto("/dashboard");
  await userPage.waitForURL("**/login?error=*");
  await expect(userPage.getByText("Sessão terminada")).toBeVisible();
  await other.close();
});

test("2FA: novo administrador é obrigado a configurar; login com código de recuperação; reposição", async ({ page, browser }) => {
  await login(page, E2E_ADMIN);
  await page.goto("/users");
  await page.fill("main input[name=name]", "Admin Novo");
  await page.fill("main input[name=email]", "admin.novo@example.com");
  await page.selectOption("main select[name=role]", "ADMIN");
  await page.getByRole("button", { name: "Criar utilizador" }).click();
  const temporary = (await page.getByTestId("temporary-password").textContent())?.trim() ?? "";

  const other = await browser.newContext();
  const admin2 = await other.newPage();
  const password = "outra frase bem longa e segura";
  await admin2.goto("/login");
  await admin2.fill("input[name=email]", "admin.novo@example.com");
  await admin2.fill("input[name=password]", temporary);
  await admin2.click("button");
  await admin2.waitForURL("**/account/password");
  await admin2.fill("input[name=currentPassword]", temporary);
  await admin2.fill("input[name=newPassword]", password);
  await admin2.fill("input[name=confirmPassword]", password);
  await admin2.getByRole("button", { name: "Alterar palavra-passe" }).click();
  // Passo seguinte obrigatório: configurar o 2FA.
  await admin2.waitForURL("**/account/mfa");

  // Sem 2FA, um administrador só acede à página de configuração.
  await admin2.goto("/campaigns");
  await admin2.waitForURL("**/account/mfa");
  await expect(admin2.getByText("Os administradores têm de usar 2FA")).toBeVisible();
  await admin2.getByRole("button", { name: "Configurar 2FA" }).click();
  // O QR (lido como faria a app) contém o URI otpauth com a mesma chave mostrada em texto.
  const qr = admin2.getByRole("img", { name: /Código QR/ });
  const viewBox = (await qr.getAttribute("viewBox")) ?? "";
  const decoded = decodeQrPath((await qr.locator("path").getAttribute("d")) ?? "", Number(viewBox.split(" ")[2]));
  expect(decoded).toMatch(/^otpauth:\/\/totp\/SMS%20AWS%3Aadmin\.novo%40example\.com\?secret=/);
  const secret = new URL(decoded ?? "").searchParams.get("secret") ?? "";
  expect(((await admin2.getByTestId("totp-secret").textContent()) ?? "").replace(/\s/g, "")).toBe(secret);
  await admin2.fill("input[name=code]", "000000");
  await admin2.getByRole("button", { name: "Ativar 2FA" }).click();
  await expect(admin2.getByRole("alert").filter({ hasText: "Código incorreto" })).toBeVisible();
  await admin2.fill("input[name=code]", totp(base32Decode(secret), new Date()));
  await admin2.getByRole("button", { name: "Ativar 2FA" }).click();
  const codes = admin2.getByTestId("recovery-codes").locator("li");
  await expect(codes).toHaveCount(10);
  const recovery = (await codes.first().textContent())?.trim() ?? "";
  await expect(admin2.getByText("2FA ativo")).toBeVisible();
  await admin2.goto("/dashboard");
  await expect(admin2.getByRole("link", { name: "Utilizadores" })).toBeVisible();

  // Novo login: palavra-passe + segundo fator (código de recuperação, uso único).
  await other.clearCookies();
  await admin2.goto("/login");
  await admin2.fill("input[name=email]", "admin.novo@example.com");
  await admin2.fill("input[name=password]", password);
  await admin2.click("button");
  await admin2.waitForURL("**/login/mfa");
  await admin2.fill("input[name=code]", "123456");
  await admin2.getByRole("button", { name: "Verificar" }).click();
  await expect(admin2.getByRole("alert").filter({ hasText: "Código inválido" })).toBeVisible();
  await admin2.fill("input[name=code]", recovery);
  await admin2.getByRole("button", { name: "Verificar" }).click();
  await admin2.waitForURL("**/account/mfa?notice=recovery");
  await expect(admin2.getByText("Entraste com um código de recuperação")).toBeVisible();

  // Reposição por outro administrador: termina a sessão; no próximo login volta a configurar.
  await page.goto("/users");
  await page.getByRole("link", { name: "Admin Novo" }).click();
  await page.locator("main form").filter({ hasText: "Confirmo a identidade" }).locator("input[name=confirm]").check();
  await page.getByRole("button", { name: "Repor 2FA" }).click();
  await expect(page.locator("main [role=status]")).toContainText("2FA reposto");
  await admin2.goto("/dashboard");
  await admin2.waitForURL("**/login?error=*");
  await other.close();
});

test("quota diária por utilizador: ADMIN define, operador é bloqueado e desbloqueado", async ({ page, browser }) => {
  await login(page, E2E_ADMIN);
  await page.goto("/users");
  await page.getByRole("link", { name: "Operador E2E" }).click();
  const quotaInput = page.locator("main input[name=dailyPartsLimit]");
  await quotaInput.fill("1");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator("main [role=status]")).toContainText("Utilizador atualizado");

  const other = await browser.newContext();
  const op = await other.newPage();
  await op.goto("/login");
  await op.fill("input[name=email]", E2E_OPERATOR.email);
  await op.fill("input[name=password]", E2E_OPERATOR.password);
  await op.click("button");
  await op.waitForURL("**/dashboard");

  await op.goto("/send");
  await expect(op.getByText("Quota diária: 0 de 1 partes SMS usadas hoje")).toBeVisible();
  await op.locator("main label", { hasText: "Destinatário" }).locator("input").fill("912345678");
  await op.locator("input[type=radio][value=TRANSACTIONAL]").check();
  await op.locator("textarea").fill("Quota E2E");
  await op.getByRole("button", { name: "Rever envio" }).click();
  await expect(op.getByText("Quota diária após este envio")).toBeVisible();
  await op.getByRole("button", { name: "Confirmar e enviar" }).click();
  await expect(op.locator("main [role=status]")).toContainText("MODO DE TESTE");

  // 2.ª mensagem: a quota (1 parte) já foi usada.
  await op.locator("main label", { hasText: "Destinatário" }).locator("input").fill("912345678");
  await op.locator("input[type=radio][value=TRANSACTIONAL]").check();
  await op.locator("textarea").fill("Não cabe");
  await op.getByRole("button", { name: "Rever envio" }).click();
  await expect(op.locator("main [role=alert]")).toContainText("Quota diária de envio atingida: usaste 1 de 1");

  // Campanha: a revisão bloqueia a confirmação enquanto não couber na quota.
  await op.goto("/campaigns/new");
  await op.locator("main label", { hasText: "Nome da campanha" }).locator("input").fill("Quota E2E");
  await op.locator("main label", { hasText: "Lista de destinatários" }).locator("select").selectOption({ label: "Clientes E2E (4 contactos)" });
  await op.locator("main label", { hasText: "Template" }).locator("select").selectOption({ label: "Aviso E2E (Transacional)" });
  await op.locator("main label", { hasText: "Data" }).locator("input").fill("15/10");
  await op.getByRole("button", { name: "Criar rascunho" }).click();
  await op.waitForURL(/\/campaigns\/[a-z0-9]+/);
  await expect(op.locator("main [role=alert]")).toContainText("A campanha precisa de 2 partes SMS e a tua quota diária tem 0 disponíveis");
  await expect(op.getByRole("button", { name: "Confirmar e enviar" })).toHaveCount(0);

  // O administrador alarga a quota; o operador confirma e a campanha conclui.
  await quotaInput.fill("100");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator("main [role=status]")).toContainText("Utilizador atualizado");
  await op.reload();
  await expect(op.getByRole("region", { name: "Resumo antes do envio" })).toContainText("Quota diária de quem confirma1 de 100 partes SMS usadas hoje");
  const confirmButton = op.getByRole("button", { name: "Confirmar e enviar" });
  await op.locator("main label", { hasText: "escreve" }).locator("input").fill("ENVIAR 2 SMS");
  await confirmButton.click();
  await expect(op.getByRole("region", { name: "Progresso da campanha" })).toContainText("Concluída", { timeout: 30_000 });
  await op.goto("/send");
  await expect(op.getByText("Quota diária: 3 de 100 partes SMS usadas hoje")).toBeVisible();

  await quotaInput.fill("");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator("main [role=status]")).toContainText("Utilizador atualizado");
  await other.close();
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
