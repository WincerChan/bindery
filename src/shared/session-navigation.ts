export function loginTarget(current: string): string {
  // Never trust a client-supplied RPC header as an external login destination.
  const next = current.startsWith("/") && !current.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(current) ? current : "/";
  return `/login?next=${encodeURIComponent(next)}`;
}
