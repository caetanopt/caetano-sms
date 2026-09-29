/** Estado das actions de 2FA. Os códigos de recuperação só existem aqui (mostrados uma vez). */
export type MfaFormState = { error?: string; recoveryCodes?: string[]; done?: boolean };
export const initialMfaFormState: MfaFormState = {};
