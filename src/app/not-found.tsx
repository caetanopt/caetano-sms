import Link from "next/link";
import { StatusScreen, primaryAction } from "@/components/status-screen";

export const metadata = { title: "Página não encontrada" };

export default function NotFound() {
  return (
    <StatusScreen
      code="Erro 404"
      title="Página não encontrada"
      actions={<Link href="/dashboard" className={primaryAction}>Voltar ao dashboard</Link>}
    >
      <p>O endereço não existe ou deixou de estar disponível. Confirma o link ou volta ao início.</p>
    </StatusScreen>
  );
}
