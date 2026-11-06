// apps/desktop/src/renderer/lib/blank-files.ts
//
// The "New > Markdown file / Text file / Word document" commands in Files.
// A new file is an ordinary upload of a blank body, so everything here is
// about getting that body and its name right before it leaves:
//
//   - Markdown and text start empty (the API accepts 0 bytes).
//   - A Word document has to be a real, openable .docx, so it carries a
//     minimal OOXML package (5 parts, 1735 bytes) the editor opens as a blank
//     page.
//   - The extension always matches the kind: "notes" becomes "notes.md".
//   - A name already used in the folder is refused here, because the upload
//     API turns a same-name upload into a NEW VERSION of the existing file.
//
// Framework-free with no "@/" imports, so it runs under `node --test`
// (blank-files.test.ts).

export type NewFileKind = "markdown" | "text" | "word";

export const NEW_FILE_KINDS: readonly NewFileKind[] = ["markdown", "text", "word"];

export const NEW_FILE_TYPES: Record<NewFileKind, { ext: string; mime: string }> = {
  markdown: { ext: ".md", mime: "text/markdown" },
  text: { ext: ".txt", mime: "text/plain" },
  word: { ext: ".docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
};

/** A blank Word document: [Content_Types].xml, _rels, word/document.xml, its rels and styles. */
export const BLANK_DOCX_BASE64 =
  "UEsDBBQAAAAIAAAAIVz1bniw+gAAAC0CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2Ru07DMBSGd57C8lolDgwIoTgduIzAUB7gyD5JrPomH7c0b4/TlA6owMJo/5fvl92uD86yPSYywUt+XTecoVdBGz9I/r55ru44owxegw0eJZ+Q+Lq7ajdTRGIl7EnyMed4LwSpER1QHSL6ovQhOcjlmAYRQW1hQHHTNLdCBZ/R5yrPHbxrH7GHnc3s6VCulyEJLXH2sBhnluQQozUKctHF3utvlOpEqEvy6KHRRFoVAxcXCbPyM+CUey0vk4xG9gYpv4ArLvERkhY6qJ0ryfr3mgs7Q98bhef83BZTUEhUntzZ+qw4MH711w7Kk0X6/xVL7xdeHH+7+wRQSwMEFAAAAAgAAAAhXLmBRHGwAAAAKgEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4J1TRN5pWgaEUJMuCKkrKgeIEjeNaB5KwqO3JwMDIAZG278/y233sDO5YUzGOwZNVQNBJ70yTjM4D8f1DkjKwikxe4cMFkzQ8VV7wlnkspMmExIpiEsMppzDntIkJ7QiVT6gK5PRRytyKaOmQciL0Eg3db2l8d0A/mGSXjGIvWqADEvAf2w/jkbiwcurRZd/nPhKFFlEjZnB3UdF1atdFRYob+nHi/wJUEsDBBQAAAAIAAAAIVzkdj45+AAAAKIBAAARAAAAd29yZC9kb2N1bWVudC54bWyNkMFOwzAMhu88RZU7SzqmUaq1uyBuSEjAA2SJ20Rq4ijxKOPpSbah7sgl9mdbv39nt/92U/UFMVn0HatXglXgFWrrx459frzcN6xKJL2WE3ro2AkS2/d3u7nVqI4OPFVZwad27pghCi3nSRlwMq0wgM+9AaOTlDGOfMaoQ0QFKeUFbuJrIbbcSevZVSb+RwaHwSp4vhq4iESYJOUjkrEhsT4bPKA+lRh4eRMoeotnHt9/qrkYrusnsWU5NznfNg8N45eBVxlzlTDk+mYjyki0o6EFD0iEbuEJhpuuAakhn/IomoIDIt3geKQzirKOL9b4n2e+/G7/C1BLAwQUAAAACAAAACFcnfOyN64AAAAbAQAAHAAAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHONz7sKwkAQBdDer1imN5tYiEg2aURIK/EDhs3kgftiZxXz9y7YKFhYXoY5d6Zun9aIB0VevFNQFSUIctoPi5sUXPvz9gCCE7oBjXekYCWGttnUFzKY8g7PS2CREccK5pTCUUrWM1nkwgdyeTL6aDHlGCcZUN9wIrkry72MnwY0X6boBgWxGyoQ/RroH9uP46Lp5PXdkks/KiSn1eT7RY9xoqTgnYvsgGxq+fVT8wJQSwMEFAAAAAgAAAAhXAjIQDExAQAAPwIAAA8AAAB3b3JkL3N0eWxlcy54bWxlkd9OwyAUxu99iob7jdrERZuxZZlZ4o0x6h7gSFlLQgE5dLU+vcDazG1X8P3gfOffcv3TquwoHEqjGbmf5yQTmptK6pqR/edu9kgy9KArUEYLRgaBZL26W/Yl+kEJzEK8xrJnpPHelpQib0QLODdW6PB2MK4FH6SraW9cZZ3hAjHYt4oWeb6gLUhNVsGwMvxZHKBTHqN0b26Uo0rHzmiPWV8CcikZ2YKSX06SQJqNxksiAP0GJVxAjmdJoyX+BnoExUhRTGSL10yBricm9Gz/ETEd66LX1dprlWwtcJlc4OCFC9Ne5LEiJeNgi4enSbx3KgDovBmT2DHJf1t6M7C0kGDhBxvCLTioHdgmulanbyFlVOnjS8XIa1yOSsPX0IqpvxGnvr93aYGnOlLg+YarP1BLAQIUAxQAAAAIAAAAIVz1bniw+gAAAC0CAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAAAAhXLmBRHGwAAAAKgEAAAsAAAAAAAAAAAAAAIABKwEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAAAAhXOR2Pjn4AAAAogEAABEAAAAAAAAAAAAAAIABBAIAAHdvcmQvZG9jdW1lbnQueG1sUEsBAhQDFAAAAAgAAAAhXJ3zsjeuAAAAGwEAABwAAAAAAAAAAAAAAIABKwMAAHdvcmQvX3JlbHMvZG9jdW1lbnQueG1sLnJlbHNQSwECFAMUAAAACAAAACFcCMhAMTEBAAA/AgAADwAAAAAAAAAAAAAAgAETBAAAd29yZC9zdHlsZXMueG1sUEsFBgAAAAAFAAUAQAEAAHEFAAAAAA==";

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The body a new file of this kind starts with. A fresh copy each call. */
export function blankFileBytes(kind: NewFileKind): Uint8Array<ArrayBuffer> {
  return kind === "word" ? decodeBase64(BLANK_DOCX_BASE64) : new Uint8Array(0);
}

/** "Untitled.md", from the (translated) base name. */
export function defaultFileName(kind: NewFileKind, base: string): string {
  return base + NEW_FILE_TYPES[kind].ext;
}

/**
 * The typed name with the kind's extension guaranteed. Trimmed; the
 * extension is matched case-insensitively ("Notes.MD" stays), and anything
 * else gets it appended ("notes" -> "notes.md", "notes.txt" -> "notes.txt.md").
 * An empty name stays empty so the name check can say it is required.
 */
export function withExtension(name: string, kind: NewFileKind): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const { ext } = NEW_FILE_TYPES[kind];
  return trimmed.toLowerCase().endsWith(ext) ? trimmed : trimmed + ext;
}

/** Where the base name ends, so the dialog can select "Untitled" and leave ".md". */
export function baseNameEnd(name: string, kind: NewFileKind): number {
  const { ext } = NEW_FILE_TYPES[kind];
  return name.toLowerCase().endsWith(ext) && name.length > ext.length ? name.length - ext.length : name.length;
}

/** Same name, ignoring case - what the folder treats as a clash. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether any of these files or folders already uses `name`. */
export function nameTaken(name: string, items: Iterable<{ name: string }>): boolean {
  for (const item of items) if (sameName(item.name, name)) return true;
  return false;
}

/**
 * Asks the API whether `name` is taken in the folder, for rows the loaded page
 * does not show. The search term narrows the listing within that one folder
 * (files and folders alike), so an exact match among the results is a clash.
 */
export async function nameTakenInFolder(
  get: <T>(path: string) => Promise<T>,
  workspaceId: string,
  folderId: string | null,
  name: string,
): Promise<boolean> {
  const params = new URLSearchParams({ workspace_id: workspaceId, q: name, per_page: "100" });
  if (folderId) params.set("folder_id", folderId);
  const res = await get<{ files?: { name: string }[]; folders?: { name: string }[] }>(`/api/files?${params}`);
  return nameTaken(name, [...(res.files ?? []), ...(res.folders ?? [])]);
}
