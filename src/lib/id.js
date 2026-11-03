let counter = 0;
// Unique enough for local ids (crypto.randomUUID isn't available on plain http).
export const uid = (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
