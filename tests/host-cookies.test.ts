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

  // Novos cookies têm de passar por host-cookies.ts (prefixo __Host- em produção).
  it("só os módulos de sessão, 2FA pendente e mensagens usam cookies()", () => {
    expect(sources.filter(({ text }) => /\bcookies\(\)/.test(text)).map(({ file }) => file).sort()).toEqual([
      "src/lib/auth/mfa-pending.ts",
      "src/lib/auth/session.ts",
      "src/lib/http/flash.ts",
      "src/lib/http/host-cookies.ts",
    ]);
  });

  it("cada escrita usa os atributos do prefixo e nenhuma remoção usa delete() simples", () => {
    const offenders = sources
      .filter(({ file }) => file !== "src/lib/http/host-cookies.ts")
      .flatMap(({ file, text }) =>
        text
          .split("\n")
          .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
          .filter(({ line }) => /\b(jar|cookies\(\)\))\.(set|delete)\(/.test(line))
          .filter(({ line }) => /\.delete\(/.test(line) || !/(hostCookieOptions|flashCookieOptions)\(/.test(line))
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });
});
