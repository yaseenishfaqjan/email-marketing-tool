/**
 * Two kinds of caller, two kinds of credential.
 *
 *   admin    — a human in the console, or a deploy script. Full access across
 *              every brand. A single bearer token in Phase 1; real user
 *              accounts come with the admin UI.
 *   api key  — one of the product applications. Scoped to ONE brand and to the
 *              scopes on the key. This is the credential that ships inside
 *              five different codebases, so it can never be allowed to reach
 *              another brand's data.
 */

import crypto from 'node:crypto';
import config from '../../config.mjs';
import { query } from '../../db.mjs';
import { hashApiKey } from '../../tokens.mjs';

function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Constant-time compare, so the token cannot be recovered a byte at a time. */
function sameToken(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function requireAdmin(req, res, next) {
  const token = bearer(req);
  if (!token || !sameToken(token, config.adminToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.isAdmin = true;
  next();
}

/**
 * Resolve a brand-scoped API key. Attaches req.brandId — every query downstream
 * takes it, so a key for LawnPilot cannot read Kept Portraits' contacts even if
 * a route forgets to filter.
 */
export function requireApiKey(scope) {
  return async (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const { rows } = await query(
        `select id, brand_id, scopes from api_keys
          where key_hash = $1 and revoked_at is null`,
        [hashApiKey(token)],
      );
      const key = rows[0];
      if (!key) return res.status(401).json({ error: 'Unauthorized' });
      if (scope && !key.scopes.includes(scope)) {
        return res.status(403).json({ error: `This key does not have the "${scope}" scope.` });
      }

      req.apiKeyId = key.id;
      req.brandId = key.brand_id;

      // Fire and forget: a failed last_used_at update must never fail a send.
      query('update api_keys set last_used_at = now() where id = $1', [key.id]).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * For admin routes that act on one brand: /v1/brands/:brandId/...
 * Admins may name any brand; an API key may only ever name its own.
 */
export function resolveBrand(req, res, next) {
  const requested = req.params.brandId;
  if (req.isAdmin) {
    req.brandId = requested;
    return next();
  }
  if (req.brandId && requested && req.brandId !== requested) {
    return res.status(403).json({ error: 'This key belongs to a different brand.' });
  }
  next();
}
