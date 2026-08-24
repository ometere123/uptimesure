import Link from "next/link";

export function EmptyState({ title, body, action }: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <div className="empty-state">
      <p className="eyebrow">No placeholder data</p>
      <h3>{title}</h3>
      <p>{body}</p>
      {action ? <Link className="button button-primary" href={action.href}>{action.label}</Link> : null}
    </div>
  );
}
