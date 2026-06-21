import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetIdentityForTests,
  bootstrapIdentity,
  getDeviceId,
  getToken,
  refreshToken,
} from "./identity";

/**
 * Identity bootstrap (doc 03 §8 / charter §4.4): on first load `POST
 * /v1/identity/device` mints a device + token, both persisted; the token is
 * attached on subsequent calls; a reload reuses the persisted deviceId.
 */

const deviceResponse = {
  deviceId: "dev_abc",
  userId: "usr_xyz",
  token: { accessToken: "tok_123", tokenType: "Bearer", expiresInSec: 3600 },
};

function mockFetchOnce(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        json: () => Promise.resolve(body),
      } as Response),
    ),
  );
}

interface FetchStep {
  status: number;
  body?: unknown;
}

/** Sequence the fetch responses; each call consumes the next step. */
function mockFetchSequence(steps: FetchStep[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fetchMock = vi.fn(() => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return Promise.resolve({
      ok: step!.status >= 200 && step!.status < 300,
      status: step!.status,
      json: () => Promise.resolve(step!.body ?? {}),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Parse the deviceId sent in a given fetch call's body. */
function sentDeviceId(fetchMock: ReturnType<typeof vi.fn>, call: number): string | null {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return (JSON.parse(init.body as string) as { deviceId: string | null }).deviceId;
}

describe("identity bootstrap", () => {
  beforeEach(() => {
    __resetIdentityForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetIdentityForTests();
  });

  it("mints + persists a device identity and attaches the token", async () => {
    expect(getToken()).toBeNull(); // before bootstrap

    mockFetchOnce(deviceResponse);
    const id = await bootstrapIdentity();

    expect(id.deviceId).toBe("dev_abc");
    expect(getToken()).toBe("tok_123");
    expect(getDeviceId()).toBe("dev_abc");

    // Persisted to localStorage for reuse across reloads.
    const raw = localStorage.getItem("dopamine.identity.v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toMatchObject({
      deviceId: "dev_abc",
      userId: "usr_xyz",
      accessToken: "tok_123",
    });
  });

  it("reuses a still-valid persisted token without re-issuing", async () => {
    mockFetchOnce(deviceResponse);
    await bootstrapIdentity();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second bootstrap with a fresh token should NOT hit the network.
    await bootstrapIdentity();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the persisted deviceId on a re-issue (same device)", async () => {
    // Seed an EXPIRED token for an existing device.
    localStorage.setItem(
      "dopamine.identity.v1",
      JSON.stringify({
        deviceId: "dev_existing",
        userId: "usr_1",
        accessToken: "old",
        expiresAt: Date.now() - 1000,
      }),
    );

    mockFetchOnce({ ...deviceResponse, deviceId: "dev_existing" });
    await bootstrapIdentity();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ deviceId: "dev_existing" });
  });
});

describe("identity — 401 re-bootstrap on a revoked device (M2)", () => {
  beforeEach(() => __resetIdentityForTests());
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetIdentityForTests();
  });

  it("re-bootstraps a fresh device when refreshToken's re-issue 401s", async () => {
    // Seed an existing device whose token the server has since revoked.
    localStorage.setItem(
      "dopamine.identity.v1",
      JSON.stringify({
        deviceId: "dev_revoked",
        userId: "usr_1",
        accessToken: "old",
        expiresAt: Date.now() + 3_600_000,
      }),
    );

    // 1st issue (deviceId=dev_revoked) → 401 (device gone); 2nd (deviceId=null) → fresh.
    const fetchMock = mockFetchSequence([
      { status: 401 },
      { status: 200, body: { ...deviceResponse, deviceId: "dev_fresh", token: { accessToken: "tok_fresh", tokenType: "Bearer", expiresInSec: 3600 } } },
    ]);

    const id = await refreshToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentDeviceId(fetchMock, 0)).toBe("dev_revoked"); // tried the known device
    expect(sentDeviceId(fetchMock, 1)).toBeNull(); // re-bootstrapped a fresh device
    expect(id.deviceId).toBe("dev_fresh");
    expect(getToken()).toBe("tok_fresh");
    expect(getDeviceId()).toBe("dev_fresh");
  });

  it("does NOT loop: a 401 on the fresh re-mint propagates (one attempt only)", async () => {
    localStorage.setItem(
      "dopamine.identity.v1",
      JSON.stringify({
        deviceId: "dev_revoked",
        userId: "usr_1",
        accessToken: "old",
        expiresAt: Date.now() + 3_600_000,
      }),
    );

    // Both the known-device issue AND the fresh mint 401 → must give up, not loop.
    const fetchMock = mockFetchSequence([{ status: 401 }, { status: 401 }]);

    await expect(refreshToken()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one re-mint attempt
  });
});
