import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizePhoneNumber(input: string, defaultCountry: "PT" = "PT") {
  const phone = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!phone || !phone.isValid()) {
    throw new Error("Número de telefone inválido");
  }
  return phone.number;
}

export function maskPhoneNumber(input: string) {
  if (input.length <= 6) return "***";
  return `${input.slice(0, 4)}******${input.slice(-3)}`;
}
