// richText keeps a styled sentence one message (the bold date lands where
// each language puts it), and the shell pieces built on it and on the
// notification labels read the same English as before i18n and Turkish once
// the language changes.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider, t } from "./i18n";
import { richText } from "./rich-text";
import { makeT, type Messages } from "../../i18n/translator";
import en from "../../i18n/messages/en.json";
import tr from "../../i18n/messages/tr.json";
import { dayGroupLabel, notificationAge } from "../components/notifications/notification-labels";
import { LegalConsent, LegalNotice } from "../components/LegalNotice";

const enT = makeT("en", en as Messages, en as Messages);
const trT = makeT("tr", tr as Messages, en as Messages);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  // Back to English for the next test: the language lives in module state.
  const r = createRoot(document.createElement("div"));
  act(() => r.render(<I18nProvider initial="en">{null}</I18nProvider>));
  act(() => r.unmount());
});

function mount(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

const DELETION_DAYS = "profile.description.yourAccountIsScheduledForDeletionOnScheduledForDay" as const;

describe("richText", () => {
  it("renders the English sentence with the element in place", () => {
    const el = mount(<p>{richText(enT, DELETION_DAYS, { days: 3 }, { scheduledFor: <b>May 3, 2027</b> })}</p>);
    expect(el.textContent).toBe("Your account is scheduled for deletion on May 3, 2027 - 3 days left.");
    expect(el.querySelector("b")?.textContent).toBe("May 3, 2027");
  });

  it("keeps the plural and puts the element where the translation does", () => {
    const one = mount(<p>{richText(enT, DELETION_DAYS, { days: 1 }, { scheduledFor: <b>D</b> })}</p>);
    expect(one.textContent).toBe("Your account is scheduled for deletion on D - 1 day left.");
    act(() => root!.unmount());
    root = null;
    const turkish = mount(<p>{richText(trT, DELETION_DAYS, { days: 2 }, { scheduledFor: <b>3 Mayıs 2027</b> })}</p>);
    // Turkish keeps the count and its unit together with a no-break space.
    expect(turkish.textContent).toBe("Hesabınızın silinmesi şu tarih için planlandı: 3 Mayıs 2027. 2\u00a0gün kaldı.");
    expect(turkish.querySelector("b")?.textContent).toBe("3 Mayıs 2027");
  });

  it("substitutes a value with ICU syntax literally", () => {
    const el = mount(
      <p>{richText(enT, "navigation.label.filesFilesSuffix", {}, { filesSuffix: <i>{"{a} #1"}</i> })}</p>,
    );
    expect(el.textContent).toBe("Files · {a} #1");
  });
});

describe("notification labels", () => {
  it("match packages/shared's English", () => {
    expect(dayGroupLabel(enT, "Today")).toBe("Today");
    expect(dayGroupLabel(enT, "Earlier")).toBe("Earlier");
    expect(notificationAge(enT, 1000, 1030)).toBe("just now");
    expect(notificationAge(enT, 0, 120)).toBe("2m");
    expect(notificationAge(enT, 0, 7200)).toBe("2h");
    expect(notificationAge(enT, 0, 3 * 86400)).toBe("3d");
  });

  it("read Turkish in Turkish", () => {
    expect(dayGroupLabel(trT, "Today")).toBe("Bugün");
    expect(notificationAge(trT, 0, 120)).toBe("2\u00a0dk.");
  });
});

describe("LegalNotice", () => {
  it("links both documents inside the English sentence", () => {
    const el = mount(<LegalNotice />);
    expect(el.textContent).toBe("By continuing, you agree to our Terms of Service and Privacy Policy.");
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Terms of Service", "Privacy Policy"]);
  });

  it("links the documents inside the Turkish sentence", () => {
    const el = mount(
      <I18nProvider initial="tr" initialMessages={tr as Messages}>
        <LegalNotice />
        <LegalConsent />
      </I18nProvider>,
    );
    expect(t("common.cancel")).toBe("İptal");
    const notice = el.querySelector("p")!;
    expect(notice.textContent).toBe(tr["common.description.byContinuingYouAgreeToOurTermsOfService"]);
    expect([...notice.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Hizmet Koşulları", "Gizlilik Politikası"]);
    expect(el.textContent).toContain(tr["sign-up.label.iAgreeToTheTermsOfServiceAndAcknowledge"]);
  });

  it("puts a link the translation words differently after the sentence", () => {
    // Spanish names the Terms "Condiciones del servicio" in the sentence but
    // "Términos del servicio" as a label.
    const el = mount(
      <I18nProvider initial="es" initialMessages={{ ...en, "profile.label.termsOfService": "Términos del servicio", "common.description.byContinuingYouAgreeToOurTermsOfService": "Al continuar, aceptas nuestras Condiciones del servicio y la Política de privacidad.", "profile.label.privacyPolicy": "Política de privacidad" } as Messages}>
        <LegalNotice />
      </I18nProvider>,
    );
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Política de privacidad", "Términos del servicio"]);
    expect(el.textContent).toBe("Al continuar, aceptas nuestras Condiciones del servicio y la Política de privacidad. Términos del servicio");
  });
});
