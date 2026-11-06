import { describe, expect, it } from "vitest";
import { renderInLocale } from "@/test-utils/rtl";
import {
  checkUploadFile, summariseRejections, validateFileName, validateFolderName, validateFolderPath,
} from "@dosya-dev/shared";
import { folderPathError, nameError, rejectionsSummary, uploadFileError } from "./policy-error";

/**
 * In English every message must read exactly as the shared validator's own
 * sentence (the one the API sends back), whichever branch refused.
 */
describe("policy errors in English match the shared validators", () => {
  const long = (n: number) => "a".repeat(n);

  it("rename", () => {
    for (const name of ["", "   ", long(256), long(101), "a/b", "ok.txt"]) {
      expect(nameError(name, "file")).toBe(validateFileName(name));
      expect(nameError(name, "folder")).toBe(validateFolderName(name));
    }
  });

  it("create folder", () => {
    for (const path of ["", "  ", long(501), `ok/${long(101)}`, "ok/a\u0000b", "//", "a/b/c"]) {
      expect(folderPathError(path)).toBe(validateFolderPath(path));
    }
  });

  it("upload", () => {
    const limits = [
      { max_file_size_gb: 1 },
      { allowed_extensions: ".jpg,.png" },
      { blocked_extensions: ".exe" },
      { max_file_size_gb: 0.5, allowed_extensions: ".jpg", blocked_extensions: ".jpg" },
    ];
    const files = [
      { name: "big.jpg", size: 2 * 1_073_741_824 },
      { name: "noext", size: 1 },
      { name: "a.exe", size: 1 },
      { name: "a.jpg", size: 1 },
    ];
    for (const l of limits) for (const f of files) expect(uploadFileError(f, l)).toBe(checkUploadFile(f, l));
  });

  it("rejection summary", () => {
    const one = [{ name: "a.exe", reason: "File type .exe is not allowed in this workspace" }];
    const same = [...one, { name: "b.exe", reason: one[0].reason }];
    const mixed = [...same, { name: "c", reason: "other" }, { name: "d", reason: "third" }];
    for (const r of [[], one, same, mixed, [...same, { name: "c", reason: "other" }]]) {
      expect(rejectionsSummary(r)).toBe(summariseRejections(r));
    }
  });
});

describe("policy errors in Arabic", () => {
  it("a file with an extension takes the yes branch, a file without one the other", async () => {
    const view = await renderInLocale(<span />, "ar");
    const allowed = { allowed_extensions: ".jpg" };
    const withExt = uploadFileError({ name: "a.png", size: 1 }, allowed)!;
    const without = uploadFileError({ name: "noext", size: 1 }, allowed)!;
    expect(withExt).toContain(".png");
    expect(withExt).not.toBe(without);
    expect(without).not.toContain(".png");
    // The selector value was never isolated, so the branch was found.
    expect(withExt).toBe(
      (await import("../../i18n/messages/ar.json")).default["files.error.fileTypeExtensionIsNotInTheAllowedList"].replace(
        /^\{hasExtension, select, yes \{(.*?)\} other \{.*\}\}$/,
        (_m, yes: string) => yes.replace("{extension}", "\u2068.png\u2069"),
      ),
    );
    view.unmount();
  });
});
