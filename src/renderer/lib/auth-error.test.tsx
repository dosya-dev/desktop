import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "./api-client";
import { authErrorMessage, isEmailUnverifiedError } from "./auth-error";

describe("authErrorMessage", () => {
  it("shows what the server said for a problem the user can fix", () => {
    expect(authErrorMessage(new ApiError("Account temporarily locked. Try again in 5 minutes.", 429), "fallback"))
      .toBe("Account temporarily locked. Try again in 5 minutes.");
  });

  it("never shows a server failure's internal text", () => {
    expect(authErrorMessage(new ApiError("Email delivery not configured", 500), "fallback"))
      .toBe("Something went wrong on our side. Wait a moment and try again.");
  });

  it("passes the connection message through", () => {
    expect(authErrorMessage(new NetworkError("Could not reach dosya."), "fallback")).toBe("Could not reach dosya.");
  });

  it("uses the form's own message for anything else", () => {
    expect(authErrorMessage(new Error("Error invoking remote method"), "fallback")).toBe("fallback");
    expect(authErrorMessage(new ApiError("", 400), "fallback")).toBe("fallback");
  });
});

describe("isEmailUnverifiedError", () => {
  it("matches only the API's unverified-email answer", () => {
    expect(isEmailUnverifiedError(new ApiError("Please verify", 403, { code: "email_unverified" }))).toBe(true);
    expect(isEmailUnverifiedError(new ApiError("Forbidden", 403))).toBe(false);
  });
});
