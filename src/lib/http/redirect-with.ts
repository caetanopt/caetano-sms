import { redirect } from "next/navigation";

/** Redireciona com uma mensagem de feedback em query string (lida pela página). */
export function redirectWith(path: string, feedback: { success?: string; error?: string }): never {
  const params = new URLSearchParams();
  if (feedback.success) params.set("success", feedback.success);
  if (feedback.error) params.set("error", feedback.error);
  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}${params.toString()}`);
}
