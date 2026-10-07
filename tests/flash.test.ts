import { describe, expect, it } from "vitest";
import { FLASH_TTL_MS, flashKey, flashUrl, readFlash, signFlash } from "@/lib/http/flash";

const KEY = flashKey("test-secret-with-at-least-32-characters!!");
const OTHER_KEY = flashKey("another-secret-with-at-least-32-characters");
const NOW = new Date("2026-10-07T10:00:00Z");
const BASE = "http://localhost:3000";

const params = (url: string) => {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of new URL(url, BASE).searchParams) {
    const previous = out[name];
    out[name] = previous === undefined ? value : [...(Array.isArray(previous) ? previous : [previous]), value];
  }
  return out;
};
const legit = (messages: Parameters<typeof flashUrl>[1], path = "/contacts") => params(flashUrl(path, messages, { key: KEY, now: NOW }));
const read = (p: Record<string, string | string[]>, at = NOW) => readFlash(p, { key: KEY, now: at });

describe("mensagens assinadas: aceitação", () => {
  it("aceita as mensagens produzidas pela aplicação (sucesso, erro, aviso)", () => {
    expect(read(legit({ success: "Contacto criado." }))).toEqual({ success: "Contacto criado." });
    expect(read(legit({ error: "Credenciais inválidas" }))).toEqual({ error: "Credenciais inválidas" });
    expect(read(legit({ notice: "recovery" }))).toEqual({ notice: "recovery" });
    expect(read(legit({ success: "A", error: "B" }))).toEqual({ success: "A", error: "B" });
  });

  it("mantém filtros da página e aceita acentos, espaços e símbolos", () => {
    const p = legit({ error: 'O template "Promo & Verão" é promocional: 100% ação' }, "/contacts?q=maria&page=2");
    expect(p.q).toBe("maria");
    expect(read(p)).toEqual({ error: 'O template "Promo & Verão" é promocional: 100% ação' });
  });

  it("aceita até ao fim do prazo e recusa depois", () => {
    const p = legit({ success: "OK" });
    expect(read(p, new Date(NOW.getTime() + FLASH_TTL_MS - 1_000))).toEqual({ success: "OK" });
    expect(read(p, new Date(NOW.getTime() + FLASH_TTL_MS + 1_000))).toEqual({});
  });
});

describe("mensagens assinadas: phishing e adulteração", () => {
  it("recusa texto sem assinatura (link forjado)", () => {
    expect(read({ error: "A sua conta foi suspensa. Ligue para 912 345 678." })).toEqual({});
  });

  it("recusa texto alterado mantendo a assinatura original", () => {
    const p = legit({ error: "Credenciais inválidas" });
    expect(read({ ...p, error: "A sua conta foi suspensa. Ligue para 912 345 678." })).toEqual({});
  });

  it("recusa mensagens acrescentadas a um link legítimo", () => {
    const p = legit({ success: "Contacto criado." });
    expect(read({ ...p, error: "Ligue para 912 345 678." })).toEqual({});
    expect(read({ ...p, notice: "recovery" })).toEqual({});
  });

  it("recusa mensagens removidas de um link legítimo (a assinatura cobre o conjunto)", () => {
    const p = legit({ success: "A", error: "B" });
    const withoutError = { ...p };
    delete withoutError.error;
    expect(read(withoutError)).toEqual({});
  });

  it("recusa troca de campo (sucesso apresentado como erro)", () => {
    const p = legit({ success: "Feito" });
    const { success, ...rest } = p;
    expect(read({ ...rest, error: success as string })).toEqual({});
  });

  it("recusa nonce, expiração ou assinatura alterados", () => {
    const p = legit({ success: "OK" });
    const [nonce, expiry, signature] = (p.f as string).split(".");
    const flip = (value: string) => value.slice(0, -1) + (value.endsWith("a") ? "b" : "a");
    expect(read({ ...p, f: `${flip(nonce)}.${expiry}.${signature}` })).toEqual({});
    expect(read({ ...p, f: `${nonce}.${(parseInt(expiry, 36) + 60).toString(36)}.${signature}` })).toEqual({});
    expect(read({ ...p, f: `${nonce}.${expiry}.${flip(signature)}` })).toEqual({});
  });

  it("recusa assinaturas de outra chave", () => {
    const p = params(flashUrl("/login", { error: "Credenciais inválidas" }, { key: OTHER_KEY, now: NOW }));
    expect(read(p)).toEqual({});
  });

  it("recusa expiração demasiado longa (não emitida pela aplicação)", () => {
    const far = new Date(NOW.getTime() + 60 * 60_000);
    const p = params(flashUrl("/login", { error: "x" }, { key: KEY, now: far }));
    expect(read(p)).toEqual({});
  });

  it("recusa parâmetros repetidos e formatos inválidos", () => {
    const p = legit({ success: "OK" });
    expect(read({ ...p, success: ["OK", "Ligue já"] })).toEqual({});
    expect(read({ ...p, f: [p.f as string, p.f as string] })).toEqual({});
    for (const f of ["", "abc", "a.b.c", `${p.f}.extra`, "zzzzzzzz.1.AAAAAAAAAAAAAAAAAAAAAA"]) {
      expect(read({ ...p, f })).toEqual({});
    }
  });

  it("um nonce sem mensagens não mostra nada", () => {
    expect(read({ f: signFlash({}, { key: KEY, now: NOW }) })).toEqual({});
  });
});

describe("chave", () => {
  it("exige AUTH_SECRET com pelo menos 32 caracteres e deriva uma subchave própria", () => {
    expect(() => flashKey("curta")).toThrow(/32/);
    expect(() => flashKey("")).toThrow(/32/);
    expect(KEY).toHaveLength(32);
    expect(KEY.equals(Buffer.from("test-secret-with-at-least-32-characters!!"))).toBe(false);
  });
});
