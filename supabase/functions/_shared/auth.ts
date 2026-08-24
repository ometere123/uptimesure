export function authorizedCron(req: Request): boolean {
  const expected = Deno.env.get("CRON_SECRET");
  const supplied = req.headers.get("x-uptimesure-cron-secret");
  return Boolean(expected && supplied && supplied === expected);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
