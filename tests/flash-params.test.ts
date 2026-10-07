import { afterEach, describe, expect, it, vi } from "vitest";
import { FLASH_NONCE_PARAM, FLASH_PARAMS, urlWithoutFlashParams } from "@/lib/http/flash-params";
import { flashUrl, readFlash } from "@/lib/http/flash";

const BASE = "http://localhost:3000";
const SECRET = "test-secret-with-at-least-32-characters!!";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

function redirectUrl(action: () => void): string {
  try {
    action();
  } catch (error) {
    return (error as { url: string }).url;
  }
  throw new Error("redirectWith não redirecionou");
}

const record = (url: string) => Object.fromEntries(new URL(url, BASE).searchParams);

describe("urlWithoutFlashParams", () => {
  it("remove mensagem e parâmetro assinado e mantém o caminho", () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    const href = `${BASE}${flashUrl("/campaigns/abc", { success: "Rascunho criado. Revê o resumo antes de confirmar." })}`;
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

describe("redirectWith: tudo o que escreve no URL é verificável e consumido", () => {
  it("só usa parâmetros de FLASH_PARAMS, a página aceita a mensagem e o URL fica limpo", async () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    const { redirectWith } = await import("@/lib/http/redirect-with");
    const url = redirectUrl(() => redirectWith("/contacts?q=maria", { success: "Contacto criado.", error: "Aviso" }));
    const added = [...new URL(url, BASE).searchParams.keys()].filter((key) => key !== "q");
    expect(added.every((key) => (FLASH_PARAMS as readonly string[]).includes(key))).toBe(true);
    expect(added).toEqual(expect.arrayContaining(["success", "error", FLASH_NONCE_PARAM]));
    expect(readFlash(record(url))).toEqual({ success: "Contacto criado.", error: "Aviso" });
    expect(urlWithoutFlashParams(new URL(url, BASE).href)).toBe("/contacts?q=maria");
  });

  it("a mesma mensagem duas vezes gera URLs diferentes (nonce)", async () => {
    vi.stubEnv("AUTH_SECRET", SECRET);
    const { redirectWith } = await import("@/lib/http/redirect-with");
    const a = redirectUrl(() => redirectWith("/lists/x", { success: "Contacto adicionado à lista." }));
    const b = redirectUrl(() => redirectWith("/lists/x", { success: "Contacto adicionado à lista." }));
    expect(a).not.toBe(b);
  });
});
