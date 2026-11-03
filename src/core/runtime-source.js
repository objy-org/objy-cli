// Development sources must be selected explicitly. Production setup resolves releases.
export function findServerDirectory() {
  throw new Error('Select a verified server release; automatic checkout discovery is disabled.');
}
