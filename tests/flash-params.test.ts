import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLASH_NONCE_PARAM, FLASH_PARAMS, urlWithoutFlashParams } from "@/lib/http/flash-params";
import { clearFlashCookie, flashCookieName, flashUrl, readFlash, rotateFlashCookie } from "@/lib/http/flash";

const BASE = "http://localhost:3000";
const SECRET = "test-secret-with-at-least-32-characters!!";

// Cookie jar em memória (o browser do pedido). `extraCookieHeader` simula cookies com o mesmo nome
// vindos de outro domínio; `renderTime` simula a renderização, onde o Next não deixa escrever.
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
let extraCookieHeader = "";
let renderTime = false;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (renderTime) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      jar.set(name, { value, options });
    },
  }),
  headers: async () =>
    new Headers({ cookie: [...[...jar].map(([name, { value }]) => `${name}=${value}`), extraCookieHeader].filter(Boolean).join("; ") }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

beforeEach(() => {
  jar.clear();
  extraCookieHeader = "";
  renderTime = false;
  vi.stubEnv("AUTH_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function redirectUrl(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return (error as { url: string }).url;
  }
  throw new Error("redirectWith não redirecionou");
}

const record = (url: string) => Object.fromEntries(new URL(url, BASE).searchParams);

describe("urlWithoutFlashParams", () => {
  it("remove mensagem e parâmetro assinado e mantém o caminho", async () => {
    const href = `${BASE}${await flashUrl("/campaigns/abc", { success: "Rascunho criado. Revê o resumo antes de confirmar." })}`;
    expect(urlWithoutFlashParams(href)).toBe("/campaigns/abc");
  });

  it("remove erro e aviso, mantendo filtros, página e hash", () => {
    const href = `${BASE}/messages?status=FAILED&error=Falhou&page=2&notice=recovery&f=abc#lista`;
    expect(urlWithoutFlashParams(href)).toBe("/messages?status=FAILED&page=2#lista");
  });

  it("remove parâmetros repetidos e vazios", () => {
    expect(urlWithoutFlashParams(`${BASE}/lists/x?success=a&success=b&error=`)).toBe("/lists/x");
  });

  it("devolve null quando não há mensagens (sem replaceState desnecessário)", () => {
    expect(urlWithoutFlashParams(`${BASE}/messages?status=SENT&page=3`)).toBeNull();
    expect(urlWithoutFlashParams(`${BASE}/dashboard`)).toBeNull();
  });
});

describe("redirectWith: mensagem ligada ao browser, verificável e consumida", () => {
  const OTHER_BROWSER = "outroBrowserAAAAAAAAAA"; // 22 caracteres: formato válido, só a assinatura falha
  const cookie = () => jar.get(flashCookieName());

  it("cria o cookie do browser (HttpOnly, 30 dias) e a página aceita a mensagem nesse browser", async () => {
    const { redirectWith } = await import("@/lib/http/redirect-with");
    const url = await redirectUrl(() => redirectWith("/contacts?q=maria", { success: "Contacto criado.", error: "Aviso" }));
    expect(cookie()?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 60 * 60, secure: false });
    expect(cookie()?.options).not.toHaveProperty("domain");
    const added = [...new URL(url, BASE).searchParams.keys()].filter((key) => key !== "q");
    expect(added.every((key) => (FLASH_PARAMS as readonly string[]).includes(key))).toBe(true);
    expect(added).toEqual(expect.arrayContaining(["success", "error", FLASH_NONCE_PARAM]));
    expect(await readFlash(record(url), "/contacts")).toEqual({ success: "Contacto criado.", error: "Aviso" });
    expect(await readFlash(record(url), "/lists")).toEqual({});
    expect(urlWithoutFlashParams(new URL(url, BASE).href)).toBe("/contacts?q=maria");
  });

  it("em produção o cookie é __Host- e Secure (sem Domain): subdomínios não o conseguem plantar", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(flashCookieName()).toBe("__Host-sms_flash_bid");
    await flashUrl("/login", { error: "Credenciais inválidas" });
    expect(jar.get("__Host-sms_flash_bid")?.options).toMatchObject({ secure: true, path: "/" });
    expect(jar.get("__Host-sms_flash_bid")?.options).not.toHaveProperty("domain");
    expect(jar.has("sms_flash_bid")).toBe(false);
  });

  it("reutiliza o cookie existente; noutro browser (outro cookie válido ou sem cookie) não mostra nada", async () => {
    const { redirectWith } = await import("@/lib/http/redirect-with");
    const first = await redirectUrl(() => redirectWith("/lists/x", { success: "Contacto adicionado à lista." }));
    const bid = cookie()!.value;
    const second = await redirectUrl(() => redirectWith("/lists/x", { success: "Contacto adicionado à lista." }));
    expect(cookie()!.value).toBe(bid);
    expect(first).not.toBe(second); // nonce

    jar.set(flashCookieName(), { value: OTHER_BROWSER });
    expect(await readFlash(record(second), "/lists/x")).toEqual({});
    jar.clear();
    expect(await readFlash(record(second), "/lists/x")).toEqual({});
  });

  it("um cookie mal formado é ignorado na leitura e substituído numa ação", async () => {
    jar.set(flashCookieName(), { value: "curto" });
    expect(await readFlash({ success: "x", f: "a.b.c" }, "/lists")).toEqual({});
    const url = await flashUrl("/lists", { success: "Lista criada." });
    expect(cookie()!.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await readFlash(record(url), "/lists")).toEqual({ success: "Lista criada." });
  });

  it("com o cookie em duplicado (plantado por outro domínio) não assina nem aceita mensagens", async () => {
    const url = await flashUrl("/login", { error: "Credenciais inválidas" });
    extraCookieHeader = `${flashCookieName()}=${OTHER_BROWSER}`;
    expect(await readFlash(record(url), "/login")).toEqual({});
    expect(await flashUrl("/login", { error: "Credenciais inválidas" })).toBe("/login");
  });

  it("durante a renderização (sem poder criar o cookie) redireciona sem mensagem e sem erro", async () => {
    renderTime = true;
    expect(await flashUrl("/login", { error: "Sessão terminada" })).toBe("/login");
    expect(cookie()).toBeUndefined();
  });

  it("no login o cookie é renovado com valor novo e prazo completo; links antigos deixam de servir", async () => {
    const before = await flashUrl("/login", { error: "Credenciais inválidas" });
    const old = cookie()!.value;
    await rotateFlashCookie();
    expect(cookie()!.value).not.toBe(old);
    expect(cookie()!.options).toMatchObject({ maxAge: 30 * 24 * 60 * 60 });
    expect(await readFlash(record(before), "/login")).toEqual({});
  });

  it("no logout o cookie é removido (Secure em produção, como exige __Host-)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await flashUrl("/login", { error: "x" });
    await clearFlashCookie();
    expect(jar.get("__Host-sms_flash_bid")).toMatchObject({ value: "", options: { maxAge: 0, secure: true, path: "/" } });
  });
});

describe("chamadas a redirectWith", () => {
  const ROOT = new URL("..", import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "generated" ? [] : files(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });

  // redirectWith é assíncrona: sem `return`/`await` a ação continuaria depois do "redirect".
  it("usam sempre return ou await", () => {
    const offenders = files(join(ROOT, "src")).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${relative(ROOT, file)}:${i + 1}` }))
        .filter(({ line }) => /\bredirectWith\(/.test(line))
        .filter(({ line }) => !/^\s*(import\b|\*|\/\/)/.test(line) && !/\bfunction redirectWith\(/.test(line))
        .filter(({ line }) => !/\b(return|await)\s+redirectWith\(/.test(line) || /redirectWith\([^)]*\)\s*\.(then|catch)\(/.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
