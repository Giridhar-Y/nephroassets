import { useRef, useState } from "react";
import { uploadBulkAssets, type BulkUploadResult } from "../api/client.js";
import { ErrorIcon, PassIcon, UploadIcon } from "../lib/icons.js";

const REQUIRED_COLUMNS = [
  "farId",
  "subClassification",
  "assetDescription",
  "status",
  "dateAcquired",
  "location",
  "usefulLifeC1Years",
  "usefulLifeC2Years"
];

const OPTIONAL_COLUMNS = [
  "serialNo",
  "qty",
  "c1OpeningCost",
  "c2OpeningCost",
  "additionsC1",
  "additionsC2",
  "dateOfAddition",
  "accDepC1Opening",
  "accDepC2Opening",
  "dateOfDisposal",
  "deletionsC1",
  "deletionsC2",
  "saleValue"
];

export function BulkUploadPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkUploadResult | null>(null);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const res = await uploadBulkAssets(file);
      setResult(res);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload the file.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto bg-white px-6 py-6">
      <h1 className="flex items-center gap-2 text-base font-semibold text-ink">
        <UploadIcon fontSize={20} />
        Bulk Upload
      </h1>
      <p className="mt-1 max-w-xl text-sm text-gray-500">
        Import or update many assets at once from a CSV or Excel file. Rows are matched to existing assets by FAR
        ID — a matching FAR ID updates that asset, and a new one creates it.
      </p>

      <div className="mt-6 max-w-2xl rounded-xl bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx"
            className="text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white hover:file:bg-accent-hover"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <button
          type="button"
          className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleUpload}
          disabled={!file || uploading}
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>

        {error && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-red-600">
            <ErrorIcon fontSize={15} />
            {error}
          </p>
        )}

        {result && (
          <div className="mt-6">
            <p className="flex items-center gap-1.5 text-sm text-green-700">
              <PassIcon fontSize={15} />
              {result.upserted} of {result.totalRows} row{result.totalRows === 1 ? "" : "s"} imported successfully.
            </p>
            {result.errors.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-medium text-red-700">
                  {result.errors.length} row{result.errors.length === 1 ? "" : "s"} could not be imported:
                </p>
                <div className="mt-2 max-h-64 overflow-auto rounded-md border border-red-100">
                  <table className="w-full text-xs">
                    <thead className="bg-red-50">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-semibold text-red-700">Row</th>
                        <th className="px-3 py-1.5 text-left font-semibold text-red-700">FAR ID</th>
                        <th className="px-3 py-1.5 text-left font-semibold text-red-700">Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.errors.map((e) => (
                        <tr key={e.row} className="border-t border-red-100">
                          <td className="px-3 py-1.5 text-gray-600">{e.row}</td>
                          <td className="px-3 py-1.5 text-gray-600">{e.farId ?? "—"}</td>
                          <td className="px-3 py-1.5 text-gray-600">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 border-t border-gray-100 pt-4">
          <h2 className="text-sm font-semibold text-ink">Expected Columns</h2>
          <p className="mt-1 text-xs text-gray-500">
            The first row must be a header naming these fields (dates as YYYY-MM-DD):
          </p>
          <p className="mt-2 text-xs text-gray-700">
            <span className="font-semibold">Required: </span>
            {REQUIRED_COLUMNS.join(", ")}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            <span className="font-semibold">Optional: </span>
            {OPTIONAL_COLUMNS.join(", ")}
          </p>
        </div>
      </div>
    </div>
  );
}
