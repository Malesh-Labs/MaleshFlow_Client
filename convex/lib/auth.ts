export function isOwnerKeyValid(ownerKey: string) {
  const configuredOwnerKey = process.env.OWNER_ACCESS_TOKEN;

  if (!configuredOwnerKey) {
    return true;
  }

  return ownerKey === configuredOwnerKey;
}

export function assertOwnerKey(ownerKey: string) {
  if (!isOwnerKeyValid(ownerKey)) {
    throw new Error("Invalid owner access token.");
  }
}
