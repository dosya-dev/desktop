import { useEffect, useMemo, useRef } from "react";
import { DosyaVideo } from "@dosya-dev/video-player/react";
import type { ReportConfig } from "@dosya-dev/video-player";
import "@dosya-dev/video-player/skin.css";
import { ApiError, apiRequest } from "@/lib/api-client";
import type { ViewerFile } from "@/components/files/FileViewer";
import { t as tNow, useT } from "@/lib/i18n";

/**
 * The file viewer's video stage: the shared Video.js player, keyed on file
 * identity. The player reads `src` only when it mounts, so the cache token in
 * rawUrl changing never restarts playback; switching to another version does,
 * through `identity`. A decode failure is the player's own card, whose
 * Download button saves through the app's own dialog (onDownload).
 *
 * The player also reads failureText only at mount, and its other text
 * (controls, the card's buttons, the report dialog) is its own English with
 * no option to replace it. The app's sentence on a card that is showing is
 * set again here on a language switch, without remounting (a remount would
 * reload the video).
 */
export function VideoPlayer({ file, rawUrl, version, onDownload }: {
  file: ViewerFile;
  rawUrl: string;
  version?: number;
  onDownload: () => void;
}) {
  const t = useT();
  const failureText = t("common.error.thisAppCanTDecodeThisVideoDownloadIt");
  const boxRef = useRef<HTMLDivElement>(null);
  const showFailureText = () => {
    // Coupled to the vendored player's DOM: the failure card's sentence is
    // the <p class="dp-stage-failure"> built in vendor/video-player/stage.ts
    // (around line 50). A re-vendor that renames it breaks this silently;
    // VideoPlayer.test.tsx covers it.
    const node = boxRef.current?.querySelector(".dp-stage-failure");
    if (node?.textContent) node.textContent = failureText;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(showFailureText, [failureText]);
  const fileId = file.id;
  const report = useMemo<ReportConfig>(() => ({
    reasons: ["playback"],
    submit: async (payload) => {
      try {
        await apiRequest<{ ok: true; reference: string }>(`/api/files/${fileId}/report`, {
          method: "POST",
          body: { reason: "playback", details: payload.details || undefined, diagnostics: payload.diagnostics },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof ApiError && err.message ? err.message : tNow("common.error.couldnTSendTheReport") };
      }
    },
  }), [fileId]);

  return (
    // The player is a left-to-right island (web's video-player.tsx pattern); its prose
    // panels take the page direction from the [dir="rtl"] rule in styles/index.css.
    <div ref={boxRef} dir="ltr" className="contents">
      <DosyaVideo
        identity={`${file.id}:${version ?? "current"}`}
        src={rawUrl}
        className="flex h-full w-full items-center justify-center"
        title={file.name}
        autoplay
        failureText={failureText}
        // A failure after a switch shows the text the player read at mount.
        onFailed={showFailureText}
        onDownloadClick={onDownload}
        report={report}
      />
    </div>
  );
}
