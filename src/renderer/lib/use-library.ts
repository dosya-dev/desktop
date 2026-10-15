// Ported from apps/web/src/hooks/use-library.ts - keep in sync with the web copy.
import { useCallback, useMemo } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import {
  mergeLibraryPages, libraryQueryKey, libraryRequestPath, LIBRARY_QUERY_ROOT,
  type Library, type LibraryPage, type LibraryView,
} from "@/lib/library-request";

export interface LibraryResult extends Library {
  isLoading: boolean;
  isPlaceholder: boolean;
  isLoadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  refresh: () => void;
}

async function fetchLibraryPage(path: string): Promise<LibraryPage> {
  const data = await api.get<LibraryPage>(path);
  if (!data.ok) throw new Error("Your library could not be loaded.");
  return data;
}

export function useLibrary(view: LibraryView | null): LibraryResult {
  const queryClient = useQueryClient();

  // No `maxPages` here on purpose. Capping the cache would evict the OLDEST
  // page on each "Load more", and `GET /api/library` pages forward only (its
  // cursor is the keyset of a page's last row), so the evicted head could not
  // be fetched back - the top of the feed would simply start 60 photos in.
  // The DSK-004 append cost was React committing ~15,000 tile elements, which
  // LibraryGrid's virtualization removes; the merge below is a few hundred
  // array pushes over small objects and was never the expense.
  const query = useInfiniteQuery({
    queryKey: view ? libraryQueryKey(view) : [LIBRARY_QUERY_ROOT, "none"],
    queryFn: ({ pageParam }) => fetchLibraryPage(libraryRequestPath(view!, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!view,
    // Previous pages are kept only WITHIN one kind. A sort or search hop
    // inside Videos still renders the old cards while the new ones load, but a
    // Videos -> Documents hop must not: the view is already rendering as
    // documents, so the previous kind's rows would come back as document rows
    // under a "Documents" title with the videos' total, and `isLoading` would
    // be false for the whole placeholder round-trip, so nothing would even
    // draw a skeleton. The key is [root, workspaceId, kind, sort, q], so
    // index 2 is the kind.
    placeholderData: (previousData, previousQuery) =>
      (view && (previousQuery?.queryKey[2] as string | undefined) === view.kind ? previousData : undefined),
    staleTime: 60_000,
  });

  // Keyed on the pages themselves, not on `query.data`: the wrapper object is
  // replaced on changes that leave the pages alone (a `pageParams` update, a
  // placeholder swap), and each of those used to redo the whole merge.
  const pages = query.data?.pages;
  const library = useMemo(() => mergeLibraryPages(pages ?? []), [pages]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const workspaceId = view?.workspaceId;
  const refresh = useCallback(() => {
    // Workspace-scoped: any file mutation (delete, move, rename, favourite)
    // can change the library, whatever sort or search is on screen.
    queryClient.invalidateQueries({ queryKey: [LIBRARY_QUERY_ROOT, workspaceId] });
  }, [queryClient, workspaceId]);

  return {
    ...library,
    isLoading: query.isLoading,
    isPlaceholder: query.isPlaceholderData,
    isLoadingMore: query.isFetchingNextPage,
    error: query.isError ? (query.error instanceof ApiError ? query.error.message : "Your library could not be loaded.") : null,
    loadMore,
    refresh,
  };
}
