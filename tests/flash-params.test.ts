import { describe, expect, it } from "vitest";
import { FLASH_PARAMS, urlWithoutFlashParams } from "@/lib/http/flash-params";

const BASE = "http://localhost:3000";

describe("urlWithoutFlashParams", () => {
  it("remove a mensagem de sucesso e mantém o caminho", () => {
    const href = `${BASE}/campaigns/abc?success=${encodeURIComponent("Rascunho criado. Revê o resumo antes de confirmar.")}`;
    expect(urlWithoutFlashParams(href)).toBe("/campaigns/abc");
  });

  it("remove erro e aviso, mantendo filtros, página e hash", () => {
    const href = `${BASE}/messages?status=FAILED&error=Falhou&page=2&notice=recovery#lista`;
    expect(urlWithoutFlashParams(href)).toBe("/messages?status=FAILED&page=2#lista");
  });

  it("remove parâmetros repetidos e vazios", () => {
    expect(urlWithoutFlashParams(`${BASE}/lists/x?success=a&success=b&error=`)).toBe("/lists/x");
  });

  it("devolve null quando não há mensagens (sem replaceState desnecessário)", () => {
    expect(urlWithoutFlashParams(`${BASE}/messages?status=SENT&page=3`)).toBeNull();
    expect(urlWithoutFlashParams(`${BASE}/dashboard`)).toBeNull();
  });

  it("cobre exatamente os parâmetros escritos por redirectWith e pelo aviso de recuperação", () => {
    expect([...FLASH_PARAMS].sort()).toEqual(["error", "notice", "success"]);
  });
});
