import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { assertOwnerKey, isOwnerKeyConfigured, isOwnerKeyValid } from "./auth";

// Lockout for failed owner-key attempts. Failures are COUNTED only by the
// non-throwing checkOwnerKey mutation (a throwing mutation would roll back its
// own failure write — Convex transactions are all-or-nothing), while every
// query and mutation ENFORCES an active lock via assertOwnerKeyGuarded.
const AUTH_THROTTLE_KEY = "owner";
const FREE_FAILURES = 10;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;

export async function getAuthThrottleRow(db: DatabaseReader) {
  return await db
    .query("authThrottle")
    .withIndex("by_key", (query) => query.eq("key", AUTH_THROTTLE_KEY))
    .unique();
}

export async function isAuthLocked(db: DatabaseReader) {
  const row = await getAuthThrottleRow(db);
  return Boolean(row?.lockedUntil && row.lockedUntil > Date.now());
}

export async function assertOwnerKeyGuarded(db: DatabaseReader, ownerKey: string) {
  if (await isAuthLocked(db)) {
    throw new Error("Too many failed access attempts. Try again later.");
  }
  assertOwnerKey(ownerKey);
}

export async function recordOwnerKeyValidation(db: DatabaseWriter, ownerKey: string) {
  const now = Date.now();
  const row = await getAuthThrottleRow(db);
  if (row?.lockedUntil && row.lockedUntil > now) {
    return { valid: false as const, lockedUntil: row.lockedUntil };
  }

  if (isOwnerKeyConfigured() && isOwnerKeyValid(ownerKey)) {
    if (row && (row.failedCount > 0 || row.lockedUntil !== null)) {
      await db.patch(row._id, { failedCount: 0, lockedUntil: null, updatedAt: now });
    }
    return { valid: true as const, lockedUntil: null };
  }

  const failedCount = (row?.failedCount ?? 0) + 1;
  const lockedUntil =
    failedCount >= FREE_FAILURES
      ? now +
        Math.min(BASE_LOCK_MS * 2 ** Math.min(failedCount - FREE_FAILURES, 10), MAX_LOCK_MS)
      : null;
  if (row) {
    await db.patch(row._id, { failedCount, lockedUntil, updatedAt: now });
  } else {
    await db.insert("authThrottle", {
      key: AUTH_THROTTLE_KEY,
      failedCount,
      lockedUntil,
      updatedAt: now,
    });
  }
  return { valid: false as const, lockedUntil };
}
