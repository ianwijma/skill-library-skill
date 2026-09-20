const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomId(): string {
  const bytes = new Uint8Array(1);
  let id = "";
  for (let i = 0; i < 8; i++) {
    let b = 252;
    while (b >= 252) {
      crypto.getRandomValues(bytes);
      b = bytes[0]!;
    }
    id += ALPHABET[b % ALPHABET.length];
  }
  return id;
}

export function generateId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  let id = randomId();
  while (taken.has(id)) id = randomId();
  return id;
}
