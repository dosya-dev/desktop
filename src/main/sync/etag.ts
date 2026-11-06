/**
 * R2 (like S3) sets the ETag of a single-part object to the MD5 of its bytes.
 * That is a free end-to-end content check on every download and every
 * presigned PUT: hash while streaming, compare at the end. Multipart objects
 * carry "<hex>-<parts>" and weak validators carry a W/ prefix; neither is a
 * body hash, so they are skipped rather than compared.
 *
 * Leaf module so node --test can load it.
 */
export function md5FromEtag(etag: string | string[] | undefined): string | null {
  if (typeof etag !== "string") return null;
  const m = /^"?([0-9a-fA-F]{32})"?$/.exec(etag.trim());
  return m ? m[1].toLowerCase() : null;
}
