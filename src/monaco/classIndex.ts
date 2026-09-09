/**
 * Known class names for the currently browsed namespace, fed by ConnectionsPanel whenever it lists
 * documents, so `##class(...)` completions can suggest real classes without a dedicated round trip.
 */
let knownClasses: string[] = [];

export function setKnownClasses(classNames: string[]): void {
  knownClasses = classNames;
}

export function getKnownClasses(): string[] {
  return knownClasses;
}
