import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetIdentityForTests,
  bootstrapIdentity,
  getDeviceId,
  getToken,
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
