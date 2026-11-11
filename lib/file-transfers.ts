import { z } from "zod";

export const uploadManifestSchema = z.object({
  manifestPath: z.string().min(3).max(4096).describe("Absolute path to a local JSON file containing requestId, takeId, uploadId and the approved files with their create_upload reservation URLs. Keeps signed URLs out of tool-call arguments."),
});

export const uploadFilesSchema = z.object({
  requestId: z.string().min(1).max(100).describe("Stable retry key for this batch; reuse it after interruption or URL refresh."),
  takeId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  uploadId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  files: z.array(z.object({
    path: z.string().min(3).max(4096).describe("Absolute path to the approved local file."),
    key: z.string().min(1).max(2048).describe("Exact storage key from create_upload."),
    size: z.number().int().positive().max(2 * 1024 ** 3),
    type: z.string().min(1).max(200),
    url: z.string().url().max(8192).describe("Signed PUT URL returned by create_upload."),
    verificationUrl: z.string().url().max(8192).optional().describe("Signed HEAD URL for this same object, if the storage reservation supplies one."),
    headers: z.record(z.string(), z.string()).describe("Required upload headers from create_upload."),
  })).min(1).max(2000),
});

export type UploadFilesInput = z.infer<typeof uploadFilesSchema>;
export type TransferReceipt = { key: string; name: string; size: number; sha256: string; etag: string; resumed: boolean };
export type TransferResult = {
  status: "uploaded" | "needs_fresh_urls" | "needs_verification" | "failed" | "cancelled" | "busy";
  requestId: string;
  takeId: string;
  uploadId: string;
  files: TransferReceipt[];
  remaining: number;
  error?: string;
};
