import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// S3-compatible object storage for the background Register export (routes/
// assetsExportJobs.ts) — deliberately the plain S3 API (not a Supabase-Storage-specific
// SDK), since Cloudflare R2 and AWS S3 both speak it: only EXPORT_S3_ENDPOINT (set for
// R2, unset for real AWS) and EXPORT_S3_FORCE_PATH_STYLE (R2 needs it) differ between
// the two. `ObjectStorage` is a narrow interface (not the raw S3Client) specifically so
// assetsExportJobs.test.ts can inject an in-memory fake instead of needing to mock the
// AWS SDK's own request machinery.
export interface ObjectStorage {
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** `body` is raw bytes, not text — every part but the last must be an EXACT fixed size
   *  on Cloudflare R2 (assetsExportJobs.ts's PART_SIZE_BYTES), which only works by slicing
   *  a byte buffer at exact offsets; a part boundary can land in the middle of a
   *  multi-byte UTF-8 character, which is fine since parts are just concatenated bytes on
   *  the far side, never individually decoded. */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<{ sizeBytes: number }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** `downloadFilename`, when given, sets the filename a browser saves the file under —
   *  the object's own key is a UUID-bearing path (exports/<userId>/<jobId>.csv), never
   *  something a user should see as a downloaded filename. Set via the presigned URL's
   *  own response-content-disposition override rather than the object's stored
   *  Content-Disposition, since the friendly name is only known at job-completion time,
   *  after the object was already fully uploaded. */
  getSignedDownloadUrl(key: string, expiresInSeconds: number, downloadFilename?: string): Promise<string>;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}

/** True once every env var a real export needs is set — checked before a job is
 *  accepted (POST /api/assets/export/jobs), same "fail fast with a clear message" pattern
 *  aiSearch.ts's OPENAI_API_KEY check already uses for an unconfigured optional feature. */
export function isObjectStorageConfigured(): boolean {
  return !!(process.env.EXPORT_S3_BUCKET && process.env.EXPORT_S3_ACCESS_KEY_ID && process.env.EXPORT_S3_SECRET_ACCESS_KEY);
}

let client: S3Client | undefined;
let bucket: string | undefined;

function getClient(): { client: S3Client; bucket: string } {
  if (client && bucket) return { client, bucket };
  bucket = process.env.EXPORT_S3_BUCKET;
  if (!bucket) throw new Error("EXPORT_S3_BUCKET is not set.");
  client = new S3Client({
    region: process.env.EXPORT_S3_REGION || "auto",
    endpoint: process.env.EXPORT_S3_ENDPOINT || undefined,
    // R2's S3-compatible endpoint requires path-style addressing
    // (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>), unlike real AWS S3's
    // default virtual-hosted style — real S3 ignores this flag if left on, so it's safe
    // to leave forcePathStyle on for either backend rather than branching on which one.
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.EXPORT_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.EXPORT_S3_SECRET_ACCESS_KEY!
    }
  });
  return { client, bucket };
}

/** The real, S3-backed implementation — the default everywhere except tests. */
export const s3ObjectStorage: ObjectStorage = {
  async createMultipartUpload(key, contentType) {
    const { client, bucket } = getClient();
    const res = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
    );
    if (!res.UploadId) throw new Error("S3 did not return an UploadId for CreateMultipartUpload.");
    return res.UploadId;
  },

  async uploadPart(key, uploadId, partNumber, body) {
    const { client, bucket } = getClient();
    const res = await client.send(
      new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body })
    );
    if (!res.ETag) throw new Error(`S3 did not return an ETag for part ${partNumber}.`);
    return res.ETag;
  },

  async completeMultipartUpload(key, uploadId, parts) {
    const { client, bucket } = getClient();
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) }
      })
    );
    // HeadObject would need one more round trip just for a byte count the caller already
    // knows (it summed every part's own body length while uploading) — not worth it.
    return { sizeBytes: 0 };
  },

  async abortMultipartUpload(key, uploadId) {
    const { client, bucket } = getClient();
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
  },

  async getSignedDownloadUrl(key, expiresInSeconds, downloadFilename) {
    const { client, bucket } = getClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: downloadFilename ? `attachment; filename="${downloadFilename}"` : undefined
      }),
      { expiresIn: expiresInSeconds }
    );
  }
};
