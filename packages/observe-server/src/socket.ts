export function socketPathForObserve(nameOrPath: string): string {
  if (nameOrPath.includes("/")) return nameOrPath;
  const safe = nameOrPath.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `/tmp/langgraph-glove-observe-${safe}.sock`;
}
