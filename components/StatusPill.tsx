export function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, "-");
  return <span className={`pill pill-${normalized}`}><span className="status-dot" />{status}</span>;
}
