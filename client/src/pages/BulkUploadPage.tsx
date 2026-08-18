import { useRef, useState } from "react";
import {
  uploadBulkAssets,
  uploadBulkDisposals,
  uploadBulkTransfers,
  type BulkUploadResult
} from "../api/client.js";
import { ErrorIcon, PassIcon, UploadIcon } from "../lib/icons.js";

type UploadType = "assets" | "disposals" | "transfers";

const TYPE_CONFIG: Record<
  UploadType,
  {
    label: string;
    description: string;
    required: string[];
    optional: string[];
    upload: (file: File) => Promise<BulkUploadResult>;
  }
> = {
  assets: {
    label: "Assets & Capitalization",
    description:
      "Import or update assets, matched by FAR ID. A new FAR ID capitalizes a brand-new asset; an existing one updates it.",
    required: [
      "farId",
      "subClassification",
      "assetDescription",
      "status",
      "dateAcquired",
      "location",
      "usefulLifeC1Years",
      "usefulLifeC2Years"
    ],
    optional: [
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
    ],
    upload: uploadBulkAssets
  },
  disposals: {
    label: "Disposals",
    description:
      "Dispose many existing assets at once — full disposal only, same as “Dispose Selected” in Register.",
    required: ["farId", "dateOfDisposal"],
    optional: ["saleValue"],
    upload: uploadBulkDisposals
  },
  transfers: {
    label: "Transfers",
    description: "Move many assets to new centers at once — one row per move, each with its own date.",
    required: ["farId", "toLocation", "transactionDate"],
    optional: [],
    upload: uploadBulkTransfers
  }
};

export function BulkUploadPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<UploadType>("assets");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkUploadResult | null>(null);

  const config = TYPE_CONFIG[type];

  function selectType(next: UploadType) {
    setType(next);
    setResult(null);
    setError(null);
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const res = await config.upload(file);
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
        Import a CSV or Excel file to add or update many assets, capitalizations, disposals, or transfers at once.
      </p>

      <div className="mt-4 flex gap-2">
        {(Object.keys(TYPE_CONFIG) as UploadType[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              type === t ? "bg-accent text-white" : "border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
            onClick={() => selectType(t)}
          >
            {TYPE_CONFIG[t].label}
          </button>
        ))}
      </div>

      <div className="mt-6 max-w-2xl rounded-xl bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-600">{config.description}</p>

        <div className="mt-4 flex items-center gap-3">
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
              {result.processed} of {result.totalRows} row{result.totalRows === 1 ? "" : "s"} processed successfully.
            </p>
            {result.errors.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-medium text-red-700">
                  {result.errors.length} row{result.errors.length === 1 ? "" : "s"} could not be processed:
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
            {config.required.join(", ")}
          </p>
          {config.optional.length > 0 && (
            <p className="mt-1 text-xs text-gray-500">
              <span className="font-semibold">Optional: </span>
              {config.optional.join(", ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
