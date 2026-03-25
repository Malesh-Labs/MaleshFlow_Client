export function assertOwnerKey(ownerKey: string) {
  const configuredOwnerKey = process.env.OWNER_ACCESS_TOKEN;

  if (!configuredOwnerKey) {
    return;
  }

  if (ownerKey !== configuredOwnerKey) {
    throw new Error("Invalid owner access token.");
  }
}
