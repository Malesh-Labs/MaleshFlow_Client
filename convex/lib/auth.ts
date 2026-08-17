export function isOwnerKeyConfigured() {
  return Boolean(process.env.OWNER_ACCESS_TOKEN);
}

// Fails closed: a missing OWNER_ACCESS_TOKEN rejects everything rather than
// silently opening the workspace to anyone with the deployment URL.
export function isOwnerKeyValid(ownerKey: string) {
  const configuredOwnerKey = process.env.OWNER_ACCESS_TOKEN;

  if (!configuredOwnerKey) {
    return false;
  }

  return ownerKey === configuredOwnerKey;
}

export function assertOwnerKey(ownerKey: string) {
  if (!isOwnerKeyConfigured()) {
    throw new Error(
      "OWNER_ACCESS_TOKEN is not configured on this deployment; access is disabled until it is set.",
    );
  }
  if (!isOwnerKeyValid(ownerKey)) {
    throw new Error("Invalid owner access token.");
  }
}
