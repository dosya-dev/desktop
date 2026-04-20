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
      staleTime: 30_000, // 30 seconds
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});
