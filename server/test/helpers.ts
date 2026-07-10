import type { FastifyInstance } from "fastify";

/** Log in via the real route and return cookies for app.inject({ cookies }). */
export async function loginAs(
  app: FastifyInstance,
  username = "alice",
  password = "correct horse",
): Promise<{ session: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`loginAs failed: HTTP ${res.statusCode} ${res.body}`);
  }
  const cookie = res.cookies.find((c) => c.name === "session");
  if (!cookie) throw new Error("loginAs: no session cookie in response");
  return { session: cookie.value };
}
