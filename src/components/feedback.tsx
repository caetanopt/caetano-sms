import { ConsumeFlashParams } from "./consume-flash-params";

export function Feedback({ success, error }: { success?: string; error?: string }) {
  return (
    <>
      {success ? (
        <div role="status" className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{success}</div>
      ) : null}
      {error ? <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</div> : null}
      {success || error ? <ConsumeFlashParams /> : null}
    </>
  );
}
