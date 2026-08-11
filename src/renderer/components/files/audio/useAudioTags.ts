import { useEffect, useState } from 'react';
import { parseTags, TAG_HEAD_BYTES, type AudioTags } from '@dosya-dev/audio-player';
import { extOf } from '@/lib/file-type';

/**
 * Reads the file's own tag header in the browser. One ranged request for the
 * first TAG_HEAD_BYTES - which is why /raw learned to answer 206 - so a 40MB
 * podcast costs a 256KB read rather than a full download.
 */
export function useAudioTags(rawUrl: string, fileName: string) {
  const [tags, setTags] = useState<AudioTags>({});
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setTags({});
    setArtworkUrl(null);

    (async () => {
      try {
        const res = await fetch(rawUrl, {
          credentials: 'include',
          headers: { Range: `bytes=0-${TAG_HEAD_BYTES - 1}` },
        });
        if (!res.ok) return;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;

        const parsed = parseTags(bytes, extOf(fileName));
        setTags(parsed);

        if (parsed.artwork) {
          objectUrl = URL.createObjectURL(
            new Blob([parsed.artwork.data as BlobPart], { type: parsed.artwork.mime }),
          );
          if (cancelled) { URL.revokeObjectURL(objectUrl); objectUrl = null; return; }
          setArtworkUrl(objectUrl);
        }
      } catch {
        // No tags is a normal outcome, not an error state - the filename
        // fallback already covers it.
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [rawUrl, fileName]);

  return { tags, artworkUrl };
}
