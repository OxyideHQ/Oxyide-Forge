import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Request-ID response correlation (M6.6).
 *
 * Emits the authoritative server-generated request ID on every
 * in-pipeline response as `X-Request-ID`, so clients and operators can
 * correlate responses with Problem Details `instance`
 * (`/requests/<same-id>`) and server logs (`reqId: <same-id>`).
 *
 * Correlation-only: the value is Fastify's server-generated `request.id`
 * (opaque per-process counter — no PII, no secrets). Client-supplied
 * `X-Request-ID`/`request-id` headers are never read (no `requestIdHeader`
 * is configured, permanently, by policy): supplied values can neither be
 * adopted nor reflected, so hostile/duplicated/oversized IDs change
 * nothing. The ID never influences authentication, authorization, or
 * any security decision — it is metadata, never authority.
 *
 * Pre-pipeline router rejections (over-long params, malformed URLs) bypass
 * hooks by framework construction and carry no header (documented
 * boundary, same class as M5.9-F01).
 */
export const REQUEST_ID_HEADER = 'x-request-id';

const requestIdPluginCallback: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
};

export const requestIdPlugin = fp(requestIdPluginCallback, {
  fastify: '5.x',
  name: 'request-id-plugin',
});
