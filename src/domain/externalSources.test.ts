import { expect, it } from "vitest";
import { serializeExternalBulletKey } from "./externalSources";

it("serializes every key dimension without collisions", () => {
  const left = serializeExternalBulletKey({
    providerId: "github-notifications",
    connectionId: "server-a/account-1",
    remoteId: "23"
  });
  const right = serializeExternalBulletKey({
    providerId: "github-notifications",
    connectionId: "server-a/account-2",
    remoteId: "23"
  });
  expect(left).not.toBe(right);
  expect(JSON.parse(left)).toEqual([
    "github-notifications",
    "server-a/account-1",
    "23"
  ]);
});
