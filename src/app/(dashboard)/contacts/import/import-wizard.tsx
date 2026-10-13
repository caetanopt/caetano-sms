"use client";

import Link from "next/link";
import { startTransition, useActionState, useMemo, useState, type FormEvent } from "react";
import { importContactsAction } from "@/app/actions/contact-import";
import {
  IMPORT_FIELD_LABELS,
  IMPORT_FIELDS,
  IMPORT_LIMITS,
  suggestMapping,
  type ColumnMapping,
  type ImportRow,
} from "@/features/contacts/import";
import { initialImportState } from "@/features/contacts/import-state";
import { CsvParseError, parseCsv, type CsvTable } from "@/lib/csv/parse";

const OUTCOME_LABELS: Record<ImportRow["outcome"], string> = {
  create: "Novo",
  existing: "Já existe (sem alterações)",
  existing_opt_out: "Já existe → opt-out",
  duplicate_in_file: "Duplicado no ficheiro",
  invalid: "Inválido",
};

const CONSENT_LABELS = { UNKNOWN: "Desconhecido", OPTED_IN: "Opt-in", OPTED_OUT: "Opt-out" } as const;

function decode(buffer: ArrayBuffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // Exportações do Excel em PT costumam vir em Windows-1252.
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

function Summary({ items }: { items: Array<[string, number]> }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <dt className="text-xs text-slate-500">{label}</dt>
          <dd className="text-xl font-bold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ImportWizard({ lists }: { lists: Array<{ id: string; name: string }> }) {
  const [state, formAction, pending] = useActionState(importContactsAction, initialImportState);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState("");
  const [table, setTable] = useState<CsvTable | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [importOptIn, setImportOptIn] = useState(false);
  const [listId, setListId] = useState("");
  const [validatedKey, setValidatedKey] = useState<string | null>(null);

  const currentKey = useMemo(
    () => JSON.stringify([csvText.length, csvText.slice(0, 200), mapping, importOptIn, listId]),
    [csvText, mapping, importOptIn, listId],
  );
  const canCommit = state.step === "preview" && validatedKey === currentKey && !pending;

  async function onFile(file: File | undefined) {
    setFileError(null);
    setTable(null);
    setCsvText("");
    setValidatedKey(null);
    if (!file) return;
    if (file.size > IMPORT_LIMITS.maxBytes) {
      setFileError(`O ficheiro excede ${IMPORT_LIMITS.maxBytes / 1_000_000} MB.`);
      return;
    }
    const text = decode(await file.arrayBuffer());
    try {
      const parsed = parseCsv(text);
      if (parsed.rows.length > IMPORT_LIMITS.maxRows) {
        setFileError(`O ficheiro tem mais de ${IMPORT_LIMITS.maxRows} linhas.`);
        return;
      }
      setFileName(file.name);
      setCsvText(text);
      setTable(parsed);
      setMapping(suggestMapping(parsed.headers));
    } catch (error) {
      setFileError(error instanceof CsvParseError ? error.message : "Não foi possível ler o ficheiro.");
    }
  }

  if (state.step === "done" && state.report) {
    const report = state.report;
    return (
      <div className="mt-6 space-y-4 rounded-xl border border-emerald-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-emerald-800">Importação concluída</h2>
        <Summary
          items={[
            ["Linhas no ficheiro", report.totalRows],
            ["Contactos criados", report.created],
            ["Já existentes", report.existing + report.existingOptOut],
            ["Opt-outs aplicados", report.optOutsApplied],
            ["Rejeitadas", report.invalid + report.duplicateInFile],
          ]}
        />
        {listId ? <p className="text-sm text-slate-600">Adicionados à lista: {report.addedToList}</p> : null}
        <div className="flex gap-3 text-sm">
          <Link href="/contacts" className="rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white">
            Ver contactos
          </Link>
          {listId ? (
            <Link href={`/lists/${listId}`} className="rounded-lg border border-slate-300 px-4 py-2 font-semibold">
              Ver lista
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  // Submissão manual: evita o reset automático do formulário pelo React 19 após a
  // action, que repunha selects/checkboxes controlados sem atualizar o estado e
  // fazia com que o que era importado divergisse do que tinha sido validado.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter);
    if (formData.get("intent") === "preview") setValidatedKey(currentKey);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-6">
      {/* Valores enviados derivam do estado React: o mesmo que define a chave validada. */}
      <input type="hidden" name="csvText" value={csvText} />
      <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
      <input type="hidden" name="listId" value={listId} />
      {importOptIn ? <input type="hidden" name="importOptIn" value="on" /> : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-semibold">1. Ficheiro</h2>
        <p className="mt-1 text-sm text-slate-600">
          CSV separado por vírgulas ou ponto e vírgula, com cabeçalho. Máximo {IMPORT_LIMITS.maxRows} linhas e{" "}
          {IMPORT_LIMITS.maxBytes / 1_000_000} MB.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Ficheiro CSV"
          onChange={(event) => onFile(event.target.files?.[0])}
          className="mt-3 block text-sm"
        />
        {fileError ? <p role="alert" className="mt-2 text-sm text-red-700">{fileError}</p> : null}
        {table ? (
          <p className="mt-2 text-sm text-slate-600">
            {fileName}: {table.rows.length} linhas, {table.headers.length} colunas (separador “{table.delimiter === "\t" ? "tab" : table.delimiter}”).
          </p>
        ) : null}
      </section>

      {table ? (
        <>
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="font-semibold">2. Mapear colunas</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {IMPORT_FIELDS.map((field) => (
                <label key={field} className="block text-sm font-medium">
                  {IMPORT_FIELD_LABELS[field]}
                  <select
                    value={mapping[field] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setMapping((current) => {
                        const next = { ...current };
                        if (value === "") delete next[field];
                        else next[field] = Number(value);
                        return next;
                      });
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  >
                    <option value="">— não importar —</option>
                    {table.headers.map((header, index) => (
                      <option key={index} value={index}>
                        {header || `Coluna ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="mb-1 text-left text-slate-500">Primeiras linhas do ficheiro</caption>
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    {table.headers.map((header, index) => (
                      <th key={index} className="px-2 py-1">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.slice(0, 5).map((row) => (
                    <tr key={row.line} className="border-t border-slate-100">
                      {table.headers.map((_, index) => (
                        <td key={index} className="px-2 py-1">{row.cells[index] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="font-semibold">3. Opções</h2>
            <label className="block text-sm font-medium">
              Adicionar a uma lista (opcional)
              <select
                value={listId}
                onChange={(event) => setListId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 sm:w-96"
              >
                <option value="">— nenhuma —</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>{list.name}</option>
                ))}
              </select>
            </label>

            <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <input
                type="checkbox"
                checked={importOptIn}
                onChange={(event) => setImportOptIn(event.target.checked)}
                className="mt-1"
              />
              <span>
                Confirmo que os contactos marcados como <strong>OPTED_IN</strong> no ficheiro deram consentimento
                documentado, com a origem indicada. Sem esta confirmação, o opt-in do ficheiro é ignorado e os contactos
                ficam com consentimento <strong>desconhecido</strong>. Opt-outs do ficheiro são sempre aplicados.
              </span>
            </label>

            <div className="flex flex-wrap gap-3">
              <button
                name="intent"
                value="preview"
                disabled={pending}
                className="rounded-lg border border-slate-300 px-5 py-2.5 font-semibold hover:bg-slate-50 disabled:opacity-50"
              >
                {pending ? "A processar…" : "Validar ficheiro"}
              </button>
              <button
                name="intent"
                value="commit"
                disabled={!canCommit}
                className="rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Importar {state.preview ? state.preview.summary.create : ""} contactos
              </button>
            </div>
            {state.step === "preview" && validatedKey !== currentKey ? (
              <p className="text-sm text-amber-800">Alteraste o ficheiro ou as opções: valida de novo antes de importar.</p>
            ) : null}
          </section>
        </>
      ) : null}

      {state.error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
      ) : null}

      {state.step === "preview" && state.preview ? (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6" aria-label="Resultado da validação">
          <h2 className="font-semibold">4. Validação</h2>
          <Summary
            items={[
              ["Novos", state.preview.summary.create],
              ["Já existentes", state.preview.summary.existing],
              ["Existentes → opt-out", state.preview.summary.existingOptOut],
              ["Duplicados no ficheiro", state.preview.summary.duplicateInFile],
              ["Inválidos", state.preview.summary.invalid],
            ]}
          />
          <p className="text-sm text-slate-600">
            Consentimento dos novos: {state.preview.summary.newOptedIn} opt-in · {state.preview.summary.newOptedOut} opt-out ·{" "}
            {state.preview.summary.newUnknown} desconhecido.
          </p>

          {state.preview.sample.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold">Amostra de números normalizados</h3>
              <ul className="mt-1 text-sm text-slate-700">
                {state.preview.sample.map((row) => (
                  <li key={row.line}>
                    Linha {row.line}: {row.name} — {row.phoneE164} ({CONSENT_LABELS[row.consentStatus]})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.preview.issues.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="mb-1 text-left font-semibold">Linhas com erros ou avisos</caption>
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Linha</th>
                    <th className="px-3 py-2">Resultado</th>
                    <th className="px-3 py-2">Detalhe</th>
                  </tr>
                </thead>
                <tbody>
                  {state.preview.issues.map((row) => (
                    <tr key={row.line} className="border-t border-slate-100">
                      <td className="px-3 py-2">{row.line}</td>
                      <td className={`px-3 py-2 ${row.outcome === "invalid" ? "text-red-700" : ""}`}>
                        {OUTCOME_LABELS[row.outcome]}
                      </td>
                      <td className="px-3 py-2">{[...row.errors, ...row.warnings].join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </form>
  );
}
