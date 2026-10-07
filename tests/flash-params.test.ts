import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLASH_NONCE_PARAM, FLASH_PARAMS, urlWithoutFlashParams } from "@/lib/http/flash-params";
import { FLASH_COOKIE, flashUrl, readFlash } from "@/lib/http/flash";

const BASE = "http://localhost:3000";
const SECRET = "test-secret-with-at-least-32-characters!!";

// Cookie jar em memória (o browser do pedido).
const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => void jar.set(name, { value, options }),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

beforeEach(() => {
  jar.clear();
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
  it("cria o cookie do browser (HttpOnly) e a página aceita a mensagem nesse browser", async () => {
    const { redirectWith } = await import("@/lib/http/redirect-with");
    const url = await redirectUrl(() => redirectWith("/contacts?q=maria", { success: "Contacto criado.", error: "Aviso" }));
    expect(jar.get(FLASH_COOKIE)?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const added = [...new URL(url, BASE).searchParams.keys()].filter((key) => key !== "q");
    expect(added.every((key) => (FLASH_PARAMS as readonly string[]).includes(key))).toBe(true);
    expect(added).toEqual(expect.arrayContaining(["success", "error", FLASH_NONCE_PARAM]));
    expect(await readFlash(record(url), "/contacts")).toEqual({ success: "Contacto criado.", error: "Aviso" });
    expect(await readFlash(record(url), "/lists")).toEqual({});
    expect(urlWithoutFlashParams(new URL(url, BASE).href)).toBe("/contacts?q=maria");
  });

  it("reutiliza o cookie existente; noutro browser (outro cookie ou sem cookie) não mostra nada", async () => {
    const { redirectWith } = await import("@/lib/http/redirect-with");
    const first = await redirectUrl(() => redirectWith("/lists/x", { success: "Contacto adicionado à lista." }));
    const bid = jar.get(FLASH_COOKIE)!.value;
    const second = await redirectUrl(() => redirectWith("/lists/x", { success: "Contacto adicionado à lista." }));
    expect(jar.get(FLASH_COOKIE)!.value).toBe(bid);
    expect(first).not.toBe(second); // nonce

    jar.set(FLASH_COOKIE, { value: "outroBrowserAAAAAAAAAAA" });
    expect(await readFlash(record(second), "/lists/x")).toEqual({});
    jar.clear();
    expect(await readFlash(record(second), "/lists/x")).toEqual({});
  });

  it("durante a renderização (sem poder criar o cookie) redireciona sem mensagem", async () => {
    expect(await flashUrl("/login", { error: "Sessão terminada" }, { canSetCookie: false })).toBe("/login");
    expect(jar.has(FLASH_COOKIE)).toBe(false);
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
        .filter(({ line }) => /\bredirectWith\(/.test(line) && !/\b(return|await)\s+redirectWith\(/.test(line))
        .filter(({ line }) => !/^\s*(import|export (async )?function|\*|\/\/)/.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
