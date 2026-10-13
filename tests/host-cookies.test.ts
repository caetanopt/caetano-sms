import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteHostCookie, deleteLegacyCookie, hostCookieName, hostCookieOptions } from "@/lib/http/host-cookies";

const written: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => void written.push({ name, value, options }),
  }),
}));

beforeEach(() => {
  written.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cookies __Host-", () => {
  it("em produção: prefixo __Host-, Secure, Path=/ e nunca Domain", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const base of ["sms_session", "sms_mfa_pending", "sms_flash_bid"]) expect(hostCookieName(base)).toBe(`__Host-${base}`);
    const options = hostCookieOptions({ sameSite: "lax", maxAge: 60 });
    expect(options).toEqual({ httpOnly: true, secure: true, path: "/", sameSite: "lax", maxAge: 60 });
    expect(options).not.toHaveProperty("domain");
  });

  it("em desenvolvimento (http): nome simples e sem Secure (o prefixo exige Secure)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(hostCookieName("sms_session")).toBe("sms_session");
    expect(hostCookieOptions({ sameSite: "strict", maxAge: 300 })).toMatchObject({ secure: false, path: "/", httpOnly: true });
  });

  it("a remoção usa os mesmos atributos (senão o browser ignora a remoção de um __Host-)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await deleteHostCookie("sms_session", "lax");
    expect(written).toEqual([
      { name: "__Host-sms_session", value: "", options: { httpOnly: true, secure: true, path: "/", sameSite: "lax", maxAge: 0 } },
    ]);
  });

  it("o cookie antigo sem prefixo é apagado só em produção", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await deleteLegacyCookie("sms_session");
    expect(written).toEqual([]);
    vi.stubEnv("NODE_ENV", "production");
    await deleteLegacyCookie("sms_session");
    expect(written).toEqual([{ name: "sms_session", value: "", options: expect.objectContaining({ maxAge: 0, path: "/" }) }]);
  });
});

describe("escrita de cookies no código", () => {
  const ROOT = new URL("..", import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "generated" ? [] : files(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  const sources = files(join(ROOT, "src")).map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, "utf8") }));
  const HELPER = "src/lib/http/host-cookies.ts";
  const ALLOWED = ["src/lib/auth/mfa-pending.ts", "src/lib/auth/session.ts", "src/lib/http/flash.ts", HELPER];
  const codeLines = (text: string) =>
    text
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      // Comentário no fim da linha não conta (mas "https://" dentro de strings mantém-se).
      .map(({ line, n }) => ({ line: line.replace(/(^|[^:])\/\/.*$/, "$1"), n }));

  // Novos cookies têm de passar por host-cookies.ts (prefixo __Host- em produção).
  it("só os módulos de sessão, 2FA pendente e mensagens importam ou usam cookies() de next/headers", () => {
    const users = sources.filter(
      ({ text }) => /\bcookies\(\)/.test(text) || /import\s*\{[^}]*\bcookies\b[^}]*\}\s*from\s*["']next\/headers["']/.test(text),
    );
    expect(users.map(({ file }) => file).sort()).toEqual([...ALLOWED].sort());
  });

  it("nenhum código escreve cookies por NextResponse/Response ou Set-Cookie em bruto", () => {
    const offenders = sources.flatMap(({ file, text }) =>
      codeLines(text)
        .filter(({ line }) => /\.cookies\.(set|delete)\(|set-cookie|ResponseCookies/i.test(line))
        .map(({ n }) => `${file}:${n}`),
    );
    expect(offenders).toEqual([]);
  });

  it("opções de cookie (httpOnly/secure) só existem no helper", () => {
    const offenders = sources
      .filter(({ file }) => file !== HELPER)
      .flatMap(({ file, text }) =>
        codeLines(text)
          .filter(({ line }) => /\bhttpOnly\b|\bsecure\s*:/.test(line))
          .map(({ n }) => `${file}:${n}`),
      );
    expect(offenders).toEqual([]);
  });

  it("nos módulos autorizados, cada escrita usa os atributos do prefixo nos argumentos e nunca delete()", () => {
    const NON_COOKIE_RECEIVERS = new Set(["params", "searchParams"]); // URLSearchParams em flash.ts
    const offenders = sources
      .filter(({ file }) => ALLOWED.includes(file) && file !== HELPER)
      .flatMap(({ file, text }) =>
        codeLines(text).flatMap(({ line, n }) =>
          [...line.matchAll(/([\w$]+|\))\.(set|delete)\((.*)$/g)]
            .filter(([, receiver]) => !NON_COOKIE_RECEIVERS.has(receiver))
            .filter(([, , method, args]) => method === "delete" || !/(hostCookieOptions|flashCookieOptions)\(/.test(args))
            .map(() => `${file}:${n}`),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
