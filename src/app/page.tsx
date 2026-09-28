import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await readSession();
  redirect(session ? "/dashboard" : "/login");
}
