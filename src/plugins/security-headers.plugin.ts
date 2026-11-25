import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Security headers emitted on every response (M5.3).
 *
 * Deliberate minimal set for a JSON API, applied centrally via onSend so
 * success, client-error, server-error, and health responses carry identical
 * headers. Values are static constants — never derived from request input —
 * so attacker data cannot alter them, and no route can bypass them by
 * registering differently.
 *
 * Deliberate omissions (documented, not oversights):
 * - Content-Security-Policy: no browser-rendered content is served; a CSP on
 *   JSON transport has no consumer and would be checklist theater.
 * - Strict-Transport-Security: TLS terminates at the edge (see deployment
 *   docs); emitting HSTS over plaintext HTTP would be wrong, and proxy
 *   guidance belongs to M5.9.
 * - Cache-Control: no shared/proxy caching layer exists; adding storage
 *   directives without a caching architecture would be speculative.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=()',
};

const securityHeadersPluginCallback: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
  });
};

export const securityHeadersPlugin = fp(securityHeadersPluginCallback, {
  fastify: '5.x',
  name: 'security-headers-plugin',
});
