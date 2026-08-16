import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry on 401 (unauthorized) or 403 (forbidden)
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          return false;
        }
        return failureCount < 2;
      },
      // Moving between pages should be instant. It was not: every page's data
      // went stale after 30s, so a normal back-and-forth re-fetched over the
      // network and showed a spinner for something already on screen a moment
      // earlier. Cached data is still revalidated in the background - this
      // changes how long it is trusted to paint immediately, not how fresh it
      // eventually becomes.
      staleTime: 5 * 60_000,
      // Survives navigating away and back. Well above staleTime on purpose:
      // evicting at the same moment data goes stale would throw away the copy
      // that makes the return trip instant.
      gcTime: 30 * 60_000,
      // A desktop window loses and regains focus constantly - alt-tab, the
      // browser hand-off during OAuth, the file dialog, any notification. Each
      // one refetched every mounted query at once, which is the stall that
      // showed up as "sometimes it takes time". Reconnect still refetches, and
      // mutations still invalidate what they touch.
      refetchOnWindowFocus: false,
      // refetchOnMount is left at its default (true), which only refetches when
      // the data is actually stale. Turning it off would mean a page opened
      // half an hour later still painted the old copy with nothing scheduled to
      // correct it.
    },
    mutations: {
      retry: false,
    },
  },
});
