import { describe, expect, it, vi } from "vitest";
import { FLASH_NONCE_PARAM, FLASH_PARAMS, flashUrl, urlWithoutFlashParams } from "@/lib/http/flash-params";

const BASE = "http://localhost:3000";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

async function redirectUrl(action: () => void): Promise<string> {
  try {
    action();
  } catch (error) {
    return (error as { url: string }).url;
  }
  throw new Error("redirectWith não redirecionou");
}

describe("flashUrl", () => {
  it("junta as mensagens e um nonce, mantendo a query existente", () => {
    expect(flashUrl("/campaigns/abc", { success: "Rascunho criado." }, "n1")).toBe(
      `/campaigns/abc?success=${encodeURIComponent("Rascunho criado.").replace(/%20/g, "+")}&f=n1`,
    );
    expect(flashUrl("/messages?status=FAILED", { error: "Falhou" }, "n2")).toBe("/messages?status=FAILED&error=Falhou&f=n2");
    expect(flashUrl("/account/mfa", { notice: "recovery" }, "n3")).toBe("/account/mfa?notice=recovery&f=n3");
  });

  it("gera um nonce diferente em cada redirect (a mesma mensagem duas vezes tem URLs diferentes)", () => {
    const a = new URL(flashUrl("/lists/x", { success: "Contacto adicionado à lista." }), BASE);
    const b = new URL(flashUrl("/lists/x", { success: "Contacto adicionado à lista." }), BASE);
    expect(a.searchParams.get(FLASH_NONCE_PARAM)).toMatch(/^[0-9a-f]{8}$/);
    expect(a.searchParams.get(FLASH_NONCE_PARAM)).not.toBe(b.searchParams.get(FLASH_NONCE_PARAM));
  });
});

describe("urlWithoutFlashParams", () => {
  it("remove mensagem e nonce e mantém o caminho", () => {
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

describe("produtores de mensagens: tudo o que escrevem no URL é consumido", () => {
  it("redirectWith só usa parâmetros de FLASH_PARAMS (e o URL fica limpo)", async () => {
    const { redirectWith } = await import("@/lib/http/redirect-with");
    const url = await redirectUrl(() => redirectWith("/contacts?q=maria", { success: "Contacto criado.", error: "Aviso" }));
    const params = new URL(url, BASE).searchParams;
    const added = [...params.keys()].filter((key) => key !== "q");
    expect(added.every((key) => (FLASH_PARAMS as readonly string[]).includes(key))).toBe(true);
    expect(added).toEqual(expect.arrayContaining(["success", "error", FLASH_NONCE_PARAM]));
    expect(urlWithoutFlashParams(new URL(url, BASE).href)).toBe("/contacts?q=maria");
  });
});
