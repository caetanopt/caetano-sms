import type { Role } from "@/lib/auth/permissions";
import { can } from "@/lib/auth/permissions";

export type ConsentStatusValue = "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";

export type ConsentDetails = {
  source: string;
  purpose?: string;
  textVersion?: string;
};

export type CurrentConsent = {
  consentStatus: ConsentStatusValue;
  optedOutAt: Date | null;
  /** O número consta da suppression list local. */
  suppressed: boolean;
};

export type ConsentChange = {
  status: "OPTED_IN" | "OPTED_OUT";
  consentAt: Date | null;
  consentSource: string;
  optedOutAt: Date | null;
  suppression: "add" | "remove";
  details: ConsentDetails;
};

export type ConsentPlan =
  | { ok: true; noop: false; change: ConsentChange }
  | { ok: true; noop: true }
  | { ok: false; message: string };

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isCurrentlyOptedOut(current: CurrentConsent) {
  return current.suppressed || current.optedOutAt !== null || current.consentStatus === "OPTED_OUT";
}

/**
 * Regras de alteração de consentimento:
 * - opt-out é sempre permitido a quem pode editar contactos;
 * - opt-in exige origem e finalidade;
 * - voltar a opt-in um número em opt-out/suppression exige perfil ADMIN;
 * - não existe transição manual para UNKNOWN (retirar consentimento = opt-out).
 */
export function planConsentChange(input: {
  current: CurrentConsent;
  to: "OPTED_IN" | "OPTED_OUT";
  details: Partial<ConsentDetails>;
  role: Role;
  now: Date;
}): ConsentPlan {
  const { current, to, role, now } = input;
  if (!can(role, "contacts:write")) {
    return { ok: false, message: "O teu perfil não permite alterar consentimentos." };
  }

  const source = clean(input.details.source);
  const purpose = clean(input.details.purpose);
  const textVersion = clean(input.details.textVersion);

  if (to === "OPTED_OUT") {
    if (current.consentStatus === "OPTED_OUT" && current.optedOutAt !== null && current.suppressed) {
      return { ok: true, noop: true };
    }
    return {
      ok: true,
      noop: false,
      change: {
        status: "OPTED_OUT",
        consentAt: null,
        consentSource: source ?? "manual",
        optedOutAt: current.optedOutAt ?? now,
        suppression: "add",
        details: { source: source ?? "manual", purpose, textVersion },
      },
    };
  }

  if (!source) return { ok: false, message: "Indica a origem do consentimento." };
  if (!purpose) return { ok: false, message: "Indica a finalidade do consentimento." };
  if (isCurrentlyOptedOut(current) && !can(role, "contacts:reopt-in")) {
    return {
      ok: false,
      message: "Este número está em opt-out. Só um administrador pode registar um novo opt-in.",
    };
  }

  return {
    ok: true,
    noop: false,
    change: {
      status: "OPTED_IN",
      consentAt: now,
      consentSource: source,
      optedOutAt: null,
      suppression: "remove",
      details: { source, purpose, textVersion },
    },
  };
}

/**
 * Estado inicial de um contacto novo. A suppression list prevalece sempre:
 * um número suprimido é criado em OPTED_OUT.
 */
export function resolveInitialConsent(input: {
  requested: ConsentStatusValue;
  details: Partial<ConsentDetails>;
  suppressed: boolean;
}):
  | { ok: true; status: ConsentStatusValue; details: ConsentDetails | null; warning?: string }
  | { ok: false; message: string } {
  const source = clean(input.details.source);
  const purpose = clean(input.details.purpose);
  const textVersion = clean(input.details.textVersion);

  if (input.suppressed) {
    return {
      ok: true,
      status: "OPTED_OUT",
      details: { source: "suppression-list", purpose, textVersion },
      warning:
        input.requested === "OPTED_OUT"
          ? undefined
          : "O número está na suppression list: o contacto foi criado em opt-out.",
    };
  }

  if (input.requested === "OPTED_IN") {
    if (!source) return { ok: false, message: "Indica a origem do consentimento." };
    if (!purpose) return { ok: false, message: "Indica a finalidade do consentimento." };
    return { ok: true, status: "OPTED_IN", details: { source, purpose, textVersion } };
  }

  if (input.requested === "OPTED_OUT") {
    return { ok: true, status: "OPTED_OUT", details: { source: source ?? "manual", purpose, textVersion } };
  }

  return { ok: true, status: "UNKNOWN", details: null };
}
