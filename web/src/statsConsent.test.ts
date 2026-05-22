import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchConsent, grantConsent } from "./statsConsent";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchConsent", () => {
  it('returns "granted" when the server reports granted', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ consent: "granted" }), { status: 200 }),
      ),
    );
    expect(await fetchConsent()).toBe("granted");
  });

  it('coerces any other consent value to "undecided"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ consent: "denied" }), { status: 200 }),
      ),
    );
    expect(await fetchConsent()).toBe("undecided");
  });

  it('coerces a missing consent field to "undecided"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })),
    );
    expect(await fetchConsent()).toBe("undecided");
  });

  it("throws on a non-ok response so the caller can fail closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );
    await expect(fetchConsent()).rejects.toThrow();
  });
});

describe("grantConsent", () => {
  it('POSTs { consent: "granted" } to the consent endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await grantConsent();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/stats/consent");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ consent: "granted" });
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );
    await expect(grantConsent()).rejects.toThrow();
  });
});
